export default {
  '{src,test}/**/*.ts': [
    'npm run lint:check',
    () => 'npx tsc --noEmit',
    'npm run format:check',
  ],
};
