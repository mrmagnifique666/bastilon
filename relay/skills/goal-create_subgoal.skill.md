# goal.create_subgoal

Creates a sub-goal with a given name, parent ID, and description.

```yaml
name: goal.create_subgoal
description: Creates a sub-goal with a given name, parent ID, and description.
admin_only: false
args:
name: {type: string, description: 'Name of the sub-goal', required: true}
parent_id: {type: number, description: 'ID of the parent goal', required: true}
description: {type: string, description: 'Description of the sub-goal', required: true}
```

```javascript
async function run(args) {
  // Implementation to create a sub-goal goes here
  return `Sub-goal ${args.name} created with parent ID ${args.parent_id} and description ${args.description}`;
}
```
