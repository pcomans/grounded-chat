import { config } from "dotenv";

// Load local secrets for the eval harness. `.env.local` wins; `.env` fills gaps.
// dotenv does not override already-set process.env vars, so real env takes priority.
config({ path: ".env.local" });
config({ path: ".env" });
