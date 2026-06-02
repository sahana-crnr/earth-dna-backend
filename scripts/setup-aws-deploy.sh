#!/usr/bin/env bash
# Provisions AWS resources for earth-dna-B.E ECS deployment (one-time setup).
# Usage: AWS_PROFILE=earthdna ./scripts/setup-aws-deploy.sh

set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-earthdna}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="596434363157"
ENV_NAME="dev2"
RC="ue1"
SUFFIX="${RC}-${ENV_NAME}"

CLUSTER="earth-dna-cluster-${SUFFIX}"
SERVICE="earth-dna-be-service-${SUFFIX}"
ECR_REPO="earth-dna-be-${SUFFIX}"
ALB_NAME="earth-dna-be-alb-${SUFFIX}"
TG_NAME="earth-dna-be-tg-${SUFFIX}"
TASK_FAMILY="earth-dna-be-${SUFFIX}"
LOG_GROUP="/ecs/${TASK_FAMILY}"
CONTAINER_NAME="web"
CONTAINER_PORT=1234

VPC_ID="vpc-0a72ad369956c87db"
PUBLIC_SUBNETS="subnet-00f7c5c92cb8dfce0 subnet-065788f0570dbfceb"
APP_SUBNETS="subnet-0701f31952b5226fa subnet-044823a468e30fe13"
CAPACITY_PROVIDER="EarthDnaStack-dev-EarthDnaAsgCapacityProviderF37C4C00-YILnKodp3OyG"
RDS_SECRET_ARN="arn:aws:secretsmanager:us-east-1:596434363157:secret:EarthDnaStackdevEarthDnaRds-mFU4AFWsieDE-g9YA5P"
DB_SG_ID="" # resolved below

GITHUB_ORG="Carnera-Tech"
GITHUB_REPO="earth-dna-B.E"
OIDC_PROVIDER_URL="https://token.actions.githubusercontent.com"
OIDC_PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
DEPLOY_ROLE_NAME="github-actions-earth-dna-be-deploy"
EXEC_ROLE_NAME="earth-dna-be-execution-role-${SUFFIX}"
TASK_ROLE_NAME="earth-dna-be-task-role-${SUFFIX}"
BE_SG_NAME="earth-dna-be-sg-${SUFFIX}"
ALB_SG_NAME="earth-dna-be-alb-sg-${SUFFIX}"

aws() { command aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"; }

echo "==> Creating GitHub OIDC provider (if missing)"
if ! aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')]" --output text | grep -q token.actions; then
  # GitHub Actions OIDC root CA SHA-1 thumbprint (documented by AWS/GitHub)
  THUMBPRINT="6938fd4efa8bfebca47c99eaefb6955582044d9b"
  aws iam create-open-id-connect-provider \
    --url "$OIDC_PROVIDER_URL" \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list "$THUMBPRINT"
  echo "Created OIDC provider"
else
  echo "OIDC provider already exists"
fi

echo "==> Creating IAM deploy role for GitHub Actions"
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${OIDC_PROVIDER_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": { "token.actions.githubusercontent.com:sub": "repo:${GITHUB_ORG}/${GITHUB_REPO}:*" }
      }
    }
  ]
}
EOF
)

if aws iam get-role --role-name "$DEPLOY_ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$DEPLOY_ROLE_NAME" --policy-document "$TRUST_POLICY"
else
  aws iam create-role --role-name "$DEPLOY_ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY" \
    --description "GitHub Actions OIDC deploy role for earth-dna-B.E"
fi

DEPLOY_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage",
        "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload"
      ],
      "Resource": "arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/${ECR_REPO}"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeServices", "ecs:UpdateService", "ecs:DescribeTaskDefinition",
        "ecs:RegisterTaskDefinition", "ecs:DescribeClusters", "ecs:ListTasks"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}",
        "arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE_NAME}"
      ]
    }
  ]
}
EOF
)
aws iam put-role-policy --role-name "$DEPLOY_ROLE_NAME" --policy-name "earth-dna-be-deploy" --policy-document "$DEPLOY_POLICY"

DEPLOY_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${DEPLOY_ROLE_NAME}"
echo "Deploy role ARN: ${DEPLOY_ROLE_ARN}"

echo "==> Creating ECR repository"
aws ecr describe-repositories --repository-names "$ECR_REPO" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$ECR_REPO" --image-scanning-configuration scanOnPush=true

echo "==> Creating CloudWatch log group"
aws logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true

echo "==> Creating ECS task execution and task roles"
EXEC_ASSUME='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$EXEC_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$EXEC_ROLE_NAME" --assume-role-policy-document "$EXEC_ASSUME"
  aws iam attach-role-policy --role-name "$EXEC_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
fi

EXEC_SECRETS_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": [
        "${RDS_SECRET_ARN}",
        "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:earthdna/be/*"
      ]
    }
  ]
}
EOF
)
aws iam put-role-policy --role-name "$EXEC_ROLE_NAME" --policy-name "secrets-access" --policy-document "$EXEC_SECRETS_POLICY"

if ! aws iam get-role --role-name "$TASK_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$TASK_ROLE_NAME" --assume-role-policy-document "$EXEC_ASSUME"
fi

EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}"
TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE_NAME}"

echo "==> Creating JWT secret (if missing)"
JWT_SECRET_NAME="earthdna/be/jwt-${SUFFIX}"
if ! aws secretsmanager describe-secret --secret-id "$JWT_SECRET_NAME" >/dev/null 2>&1; then
  JWT_VAL=$(openssl rand -hex 32)
  aws secretsmanager create-secret --name "$JWT_SECRET_NAME" --secret-string "{\"JWT_SECRET\":\"${JWT_VAL}\"}"
fi
JWT_SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$JWT_SECRET_NAME" --query ARN --output text)

echo "==> Creating security groups"
ALB_SG_ID=$(aws ec2 create-security-group \
  --group-name "$ALB_SG_NAME" \
  --description "Public ALB for earth-dna-B.E" \
  --vpc-id "$VPC_ID" \
  --query GroupId --output text 2>/dev/null || \
  aws ec2 describe-security-groups --filters "Name=group-name,Values=${ALB_SG_NAME}" --query 'SecurityGroups[0].GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id "$ALB_SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 2>/dev/null || true
aws ec2 authorize-security-group-ingress --group-id "$ALB_SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0 2>/dev/null || true

BE_SG_ID=$(aws ec2 create-security-group \
  --group-name "$BE_SG_NAME" \
  --description "earth-dna-B.E ECS tasks" \
  --vpc-id "$VPC_ID" \
  --query GroupId --output text 2>/dev/null || \
  aws ec2 describe-security-groups --filters "Name=group-name,Values=${BE_SG_NAME}" --query 'SecurityGroups[0].GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id "$BE_SG_ID" --protocol tcp --port "$CONTAINER_PORT" --source-group "$ALB_SG_ID" 2>/dev/null || true

# Allow BE tasks to reach RDS (find DB security group from existing app SG rule)
DB_SG_ID=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=*EarthDnaDbSg*" --query 'SecurityGroups[0].GroupId' --output text)
if [ -n "$DB_SG_ID" ] && [ "$DB_SG_ID" != "None" ]; then
  aws ec2 authorize-security-group-ingress --group-id "$DB_SG_ID" --protocol tcp --port 5432 --source-group "$BE_SG_ID" 2>/dev/null || true
fi

echo "==> Creating public Application Load Balancer"
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name "$(echo "$ALB_NAME" | cut -c1-32)" \
  --type application \
  --scheme internet-facing \
  --subnets $PUBLIC_SUBNETS \
  --security-groups "$ALB_SG_ID" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || \
  aws elbv2 describe-load-balancers --names "$(echo "$ALB_NAME" | cut -c1-32)" --query 'LoadBalancers[0].LoadBalancerArn' --output text)

TG_ARN=$(aws elbv2 create-target-group \
  --name "$(echo "$TG_NAME" | cut -c1-32)" \
  --protocol HTTP \
  --port "$CONTAINER_PORT" \
  --vpc-id "$VPC_ID" \
  --target-type ip \
  --health-check-path "/api/v1" \
  --health-check-interval-seconds 30 \
  --health-check-timeout-seconds 5 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || \
  aws elbv2 describe-target-groups --names "$(echo "$TG_NAME" | cut -c1-32)" --query 'TargetGroups[0].TargetGroupArn' --output text)

LISTENER_ARN=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query 'Listeners[?Port==`80`].ListenerArn' --output text 2>/dev/null)
if [ -z "$LISTENER_ARN" ] || [ "$LISTENER_ARN" = "None" ]; then
  aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
    --default-actions Type=forward,TargetGroupArn="$TG_ARN"
fi

ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].DNSName' --output text)
echo "ALB DNS: http://${ALB_DNS}"

echo "==> Registering initial task definition"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest"

TASK_DEF_JSON=$(cat <<EOF
{
  "family": "${TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["EC2"],
  "executionRoleArn": "${EXEC_ROLE_ARN}",
  "taskRoleArn": "${TASK_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "${CONTAINER_NAME}",
      "image": "public.ecr.aws/docker/library/node:20-alpine",
      "memoryReservation": 512,
      "essential": true,
      "portMappings": [{ "containerPort": ${CONTAINER_PORT}, "protocol": "tcp" }],
      "command": ["sh", "-c", "echo placeholder && sleep 3600"],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "${CONTAINER_PORT}" },
        { "name": "API_PREFIX", "value": "api/v1" },
        { "name": "DB_SYNC", "value": "false" },
        { "name": "DB_LOGGING", "value": "false" }
      ],
      "secrets": [
        { "name": "DB_HOST", "valueFrom": "${RDS_SECRET_ARN}:host::" },
        { "name": "DB_PORT", "valueFrom": "${RDS_SECRET_ARN}:port::" },
        { "name": "DB_USERNAME", "valueFrom": "${RDS_SECRET_ARN}:username::" },
        { "name": "DB_PASSWORD", "valueFrom": "${RDS_SECRET_ARN}:password::" },
        { "name": "DB_NAME", "valueFrom": "${RDS_SECRET_ARN}:dbname::" },
        { "name": "JWT_SECRET", "valueFrom": "${JWT_SECRET_ARN}:JWT_SECRET::" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${LOG_GROUP}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "earth-dna-be"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -qO- http://localhost:${CONTAINER_PORT}/api/v1 || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
EOF
)

TASK_DEF_ARN=$(aws ecs register-task-definition --cli-input-json "$TASK_DEF_JSON" --query 'taskDefinition.taskDefinitionArn' --output text)

echo "==> Creating ECS service"
if aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].status' --output text 2>/dev/null | grep -q ACTIVE; then
  echo "ECS service already exists: ${SERVICE}"
else
  aws ecs create-service \
    --cluster "$CLUSTER" \
    --service-name "$SERVICE" \
    --task-definition "$TASK_DEF_ARN" \
    --desired-count 1 \
    --capacity-provider-strategy "capacityProvider=${CAPACITY_PROVIDER},weight=1" \
    --network-configuration "awsvpcConfiguration={subnets=[$(echo $APP_SUBNETS | sed 's/ /,/g')],securityGroups=[${BE_SG_ID}],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=${TG_ARN},containerName=${CONTAINER_NAME},containerPort=${CONTAINER_PORT}" \
    --health-check-grace-period-seconds 120 \
    --placement-strategy type=spread,field=attribute:ecs.availability-zone
  echo "Created ECS service: ${SERVICE}"
fi

cat <<SUMMARY

=== Setup complete ===
GitHub secret to configure:
  AWS_ROLE_ARN = ${DEPLOY_ROLE_ARN}

GitHub repository variables (optional):
  AWS_REGION = ${AWS_REGION}
  EARTH_DNA_ENV = ${ENV_NAME}

ECS cluster:  ${CLUSTER}
ECS service:  ${SERVICE}
ECR repo:     ${ECR_REPO}
ALB URL:      http://${ALB_DNS}
Task family:  ${TASK_FAMILY}
Container:    ${CONTAINER_NAME} (port ${CONTAINER_PORT})

SUMMARY
