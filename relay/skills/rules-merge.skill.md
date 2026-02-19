# rules.merge

Intelligently merge a new behavior instruction into the existing ruleset. Uses Ollama/Groq to detect duplicates, resolve conflicts, and create clean rules. Auto-approves the result. Example: 'reponds toujours en bullets' → creates/updates a communication rule.

```yaml
name: rules.merge
description: Intelligently merge a new behavior instruction into the existing ruleset. Uses Ollama/Groq to detect duplicates, resolve conflicts, and create clean rules. Auto-approves the result. Example: 'reponds toujours en bullets' → creates/updates a communication rule.
admin_only: false
args:
instruction: {type: string, description: "Instruction to merge", required: true}
category: {type: string, description: "Category", required: false}
```

```javascript
async function rulesMerge(instruction, category) {
  // Placeholder code: Replace with actual implementation
  return `Rules merged: instruction=${instruction}, category=${category}`;
}
```
