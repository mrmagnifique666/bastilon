# CODE REQUEST: SUB-GOALS ADAPTIVE SYSTEM

**Requested by:** Nicolas Léveillé
**Date:** 2026-02-13
**Priority:** HIGH
**Status:** PENDING

---

## Problem

When Kingston encounters obstacles during goal execution, he currently gets stuck or needs user intervention.

**Example scenario:**
- **Main goal:** Make restaurant reservation
- **Obstacle:** No online booking available
- **Current behavior:** Report failure to user
- **Desired behavior:** Create sub-goal "Call restaurant via phone API" and continue autonomously

---

## Solution: Sub-Goals System

### Architecture

```typescript
interface SubGoal {
  id: number;
  parent_goal_id?: number;  // null for root goals
  title: string;
  description: string;
  strategy: string;         // Approach to solve this goal
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  created_at: number;
  completed_at?: number;
  depth: number;            // How many levels deep (0 = root)
  result?: string;
  blocking_reason?: string;
}
```

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS subgoals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_goal_id INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  strategy TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  depth INTEGER DEFAULT 0,
  result TEXT,
  blocking_reason TEXT,
  FOREIGN KEY (parent_goal_id) REFERENCES subgoals(id)
);

CREATE INDEX idx_subgoals_parent ON subgoals(parent_goal_id);
CREATE INDEX idx_subgoals_status ON subgoals(status);
```

---

## Skills API

### 1. `subgoals.create`
**Description:** Create a new sub-goal when encountering an obstacle

**Args:**
- `title` (string, required): Short title for the sub-goal
- `description` (string, required): What needs to be accomplished
- `strategy` (string, required): How you plan to solve it
- `parent_goal_id` (number, optional): ID of parent goal (omit for root goals)

**Returns:** Sub-goal ID

**Example:**
```json
{
  "type": "tool_call",
  "tool": "subgoals.create",
  "args": {
    "title": "Call restaurant for reservation",
    "description": "Restaurant XYZ has no online booking. Need to call them at (819) 555-1234 to book table for 2 on Friday 7pm",
    "strategy": "Use phone.call skill to reach restaurant and request reservation via voice",
    "parent_goal_id": 42
  }
}
```

---

### 2. `subgoals.update`
**Description:** Update status and result of a sub-goal

**Args:**
- `id` (number, required): Sub-goal ID
- `status` (string, required): 'in_progress' | 'completed' | 'failed' | 'blocked'
- `result` (string, optional): What happened
- `blocking_reason` (string, optional): Why it's blocked (if status=blocked)

**Returns:** Confirmation message

**Example:**
```json
{
  "type": "tool_call",
  "tool": "subgoals.update",
  "args": {
    "id": 43,
    "status": "completed",
    "result": "Called restaurant, reservation confirmed for Friday Feb 14, 7pm, table for 2 under name Nicolas Léveillé. Confirmation code: RES-2024-143"
  }
}
```

---

### 3. `subgoals.tree`
**Description:** View goal hierarchy tree

**Args:**
- `root_id` (number, optional): Show tree from specific root (omit to show all active)

**Returns:** ASCII tree visualization

**Example output:**
```
[42] Make restaurant reservation (in_progress)
├─ [43] Call restaurant for reservation (completed) ✓
└─ [44] Send confirmation to Nicolas via Telegram (pending)

[45] Find Shopify credentials (in_progress)
├─ [46] Search .env file (completed) ✓
├─ [47] Check documentation (in_progress)
└─ [48] Create Shopify API app (pending)
```

---

### 4. `subgoals.list`
**Description:** List sub-goals filtered by status

**Args:**
- `status` (string, optional): Filter by status
- `depth` (number, optional): Filter by depth level
- `limit` (number, optional): Max results (default: 20)

**Returns:** List of sub-goals

---

### 5. `subgoals.next`
**Description:** Get next actionable sub-goal (smart prioritization)

**Args:** None

**Returns:** The highest-priority pending sub-goal, considering:
- Depth (shallower goals first - finish branches before starting new ones)
- Creation time (older first)
- Parent status (don't work on sub-goals if parent is blocked)

**Example:**
```json
{
  "id": 47,
  "title": "Check Shopify documentation",
  "description": "Search docs/ folder for Shopify API credentials or setup instructions",
  "strategy": "Use files.search to grep for 'SHOPIFY' in markdown files",
  "parent_goal_id": 45,
  "depth": 1,
  "status": "pending"
}
```

---

## Workflow Example

### Scenario: Make restaurant reservation

**1. User request:**
> "Book table at Chez Henri for Friday 7pm, 2 people"

**2. Kingston creates root goal:**
```javascript
subgoals.create({
  title: "Book table at Chez Henri",
  description: "Reserve table for 2 on Friday Feb 14, 7pm",
  strategy: "Check if restaurant has online booking, use it. Otherwise call them."
})
// Returns: goal_id = 50
```

**3. Kingston tries online booking:**
- Navigates to restaurant website
- Discovers: No online booking form

**4. Kingston creates sub-goal:**
```javascript
subgoals.create({
  title: "Call Chez Henri for reservation",
  description: "Phone booking required - no online form available",
  strategy: "Use phone.call to reach restaurant at (819) 777-8888",
  parent_goal_id: 50
})
// Returns: goal_id = 51
```

**5. Kingston marks first attempt as failed, new sub-goal as in_progress:**
```javascript
subgoals.update({
  id: 50,
  status: "in_progress",
  result: "Online booking not available, switched to phone strategy"
})

subgoals.update({
  id: 51,
  status: "in_progress"
})
```

**6. Kingston calls restaurant:**
```javascript
phone.call({
  reason: "Make reservation at Chez Henri for 2 people, Friday Feb 14 at 7pm"
})
```

**7. Call succeeds, update sub-goal:**
```javascript
subgoals.update({
  id: 51,
  status: "completed",
  result: "Reservation confirmed. Confirmation code: CH-FEB14-0700-NL"
})
```

**8. Update parent goal:**
```javascript
subgoals.update({
  id: 50,
  status: "completed",
  result: "Table for 2 booked at Chez Henri, Friday Feb 14 7pm. Confirmation: CH-FEB14-0700-NL"
})
```

**9. Kingston notifies Nicolas:**
```javascript
telegram.send({
  chatId: "8189338836",
  text: "✅ Réservation confirmée:\nChez Henri\nVendredi 14 fév, 19h00\n2 personnes\nCode: CH-FEB14-0700-NL"
})
```

---

## Integration with Existing Systems

### With `mind.peodc`
When a PEODC workflow encounters blockers, it can create sub-goals:

```javascript
// In Phase D (Direction), obstacle encountered
subgoals.create({
  title: "Generate Shopify Access Token",
  description: "SHOPIFY_ACCESS_TOKEN missing in .env, need to create custom app in Shopify admin",
  strategy: "Use browser.navigate to access Shopify admin, create app, copy token",
  parent_goal_id: current_peodc_workflow_id
})
```

### With `autonomous.goal`
Sub-goals are **more granular** than autonomous goals:
- Autonomous goals: High-level objectives ("Increase revenue", "Build merch store")
- Sub-goals: Tactical steps when obstacles appear ("Call restaurant", "Find API credentials")

They can **co-exist**:
- Use `autonomous.goal` for strategic planning
- Use `subgoals` for real-time adaptation during execution

---

## Implementation Files

### 1. Database Migration
**File:** `src/db/migrations/007_subgoals.ts`

### 2. Skill Implementation
**File:** `src/skills/builtin/subgoals.ts`

### 3. Integration Hook
**File:** `src/agents/adaptive-executor.ts` (optional)

A helper agent that:
- Monitors skill execution failures
- Suggests sub-goals when obstacles detected
- Can be called via `agents.spawn` when stuck

---

## Success Metrics

**Before sub-goals:**
- Obstacle encountered → Ask user for help → Wait for response → Resume

**After sub-goals:**
- Obstacle encountered → Create sub-goal → Execute alternative strategy → Continue autonomously

**Target:**
- 70%+ of obstacles resolved without user intervention
- Average time-to-resolution reduced by 50%
- User only intervened for truly ambiguous decisions (not tactical blockers)

---

## Priority Justification

**HIGH** because:
1. Directly addresses autonomy gap (Kingston gets stuck too often)
2. Enables true adaptive behavior (hallmark of AGI)
3. Unlocks complex multi-step workflows (like PEODC but more flexible)
4. Required for agent to operate independently for hours/days

---

## Example Use Cases

1. **Restaurant booking:** No online form → Call restaurant
2. **API credentials:** Missing in .env → Navigate to admin panel, create app, copy token
3. **Data not in database:** Missing info → Search web, scrape data, insert into DB
4. **Service down:** Primary API failing → Switch to backup API
5. **File not found:** Expected file missing → Ask user for path OR search filesystem
6. **Permission denied:** Can't access resource → Request credentials from user OR find alternative source

---

## Notes

- Sub-goals should be **created proactively** when obstacles appear
- Depth limit: Max 3 levels (root → sub → sub-sub) to prevent infinite recursion
- If a sub-goal also gets blocked, Kingston can:
  1. Create another sub-sub-goal (if depth < 3)
  2. Mark as blocked and escalate to user
  3. Try alternative strategy at same level

---

**Émile (Claude Code CLI):** Please implement this system.

**Expected timeline:** 1-2 hours

**Dependencies:** None (SQLite already configured)

**Testing:** Kingston will test with "Find Shopify credentials" scenario currently in progress.
