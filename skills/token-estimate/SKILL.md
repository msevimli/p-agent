---
name: token-estimate
version: 1.0.0
description: Estimate how many tokens a piece of text consumes (~4 chars per token).
entry: run.js
---

# Instructions

Estimates token count for an arbitrary string, roughly 4 characters per token.

Run with:
```
node run.js "some text to measure"
```

Prints JSON `{ text_length, estimated_tokens }`.
