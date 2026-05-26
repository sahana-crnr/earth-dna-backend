---
description: Fetch and summarise official documentation for the given NestJS / TypeORM topic
---

Topic requested: **$ARGUMENTS**

Step 1 — Identify the best official documentation URL for this topic.
Use the table in `CLAUDE.md` under "Key NestJS Doc Sections" and "TypeORM Doc Sections".
If the topic maps to multiple pages, list all relevant URLs.

Step 2 — Fetch the content of each URL using WebFetch.

Step 3 — Produce a focused summary containing:

### 📖 Topic: <topic>
**Source:** <URL(s)>

#### What it is
One paragraph explanation.

#### When to use it in this project
Concrete advice for earth-dna-BE (reference actual modules/entities we have).

#### Code pattern
A minimal, copy-paste-ready TypeScript + NestJS code snippet following our project conventions.

#### Gotchas / common mistakes
Bullet list of things to watch out for.

#### Related topics
Links to adjacent docs pages worth knowing.

Step 4 — Ask: "Would you like me to apply this pattern to a specific module?"
