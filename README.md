# Job Search Agent

A daily job-hunting agent. Every evening it scans the career sites of about 40 tech companies, keeps the newly posted entry-level software roles, ranks them against my resume with Workers AI (embeddings + Llama 3.3), and emails me the best matches. It runs free on GitHub Actions.

```mermaid
flowchart LR
  SC["Scan<br/>36 career sites"] --> CL["Screen<br/>entry-level rules"]
  CL --> FI["Filter<br/>location, posted today, not sent before"]
  FI --> RK["Rank<br/>resume match score"]
  RK <--> AI["Workers AI<br/>bge embeddings · Llama 3.3"]
  RK --> MAIL["Daily email"]
```

**Stack:** TypeScript · Node · Cloudflare Workers AI · GitHub Actions · 102 tests
