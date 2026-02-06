# Task 03: Configuration Types and Zod Schemas

**Layer:** 0 (Foundation)
**Dependencies:** None
**Can run in parallel with:** Task 01, Task 02

## What to Do

Add the team configuration types to the existing config system so users can enable and configure teams in `openclaw.json`.

## Files to Modify

### 1. `src/config/types.gateway.ts`

Add `TeamsGatewayConfig` type and a `teams` field on `GatewayConfig`. Add the type definition before the `GatewayConfig` type (around line 208):

```typescript
// ---- Teams Configuration ----

export type TeamsStorageConfig = {
  /** Base directory for team data (default: "~/.openclaw/teams"). */
  basePath?: string;
  /** Task list storage format (default: "json"). */
  taskListFormat?: "json" | "jsonl";
  /** Auto-delete read messages after this many hours (default: 24). */
  mailboxTTLHours?: number;
};

export type TeamsTmuxConfig = {
  /** tmux pane layout (default: "tiled"). */
  layout?: "tiled" | "even-horizontal" | "even-vertical";
  /** tmux session name prefix (default: "openclaw-team"). */
  sessionPrefix?: string;
};

export type TeamsDisplayConfig = {
  /** Display mode for team visualization (default: "in-process"). */
  mode?: "in-process" | "tmux";
  /** tmux-specific settings (only used when mode is "tmux"). */
  tmux?: TeamsTmuxConfig;
};

export type TeamsGatewayConfig = {
  /** Master switch for team functionality (default: false). */
  enabled?: boolean;
  /** Maximum concurrent active teams across all agents (default: 3). */
  maxActiveTeams?: number;
  /** Maximum teammates per team (default: 5). */
  maxTeammatesPerTeam?: number;
  /** Default model for spawned teammates. */
  defaultModel?: string;
  /** How long to retain completed team data in days (default: 7). */
  retentionDays?: number;
  /** Storage settings. */
  storage?: TeamsStorageConfig;
  /** Display mode settings. */
  display?: TeamsDisplayConfig;
};
```

Then add `teams` to the existing `GatewayConfig` type (around line 210):

```typescript
export type GatewayConfig = {
  // ... existing fields ...
  trustedProxies?: string[];
  /** Agent Teams configuration. */
  teams?: TeamsGatewayConfig; // NEW
};
```

### 2. `src/config/types.agents.ts`

Add `teams` field to the `AgentConfig` type (after `tools` on line 62):

```typescript
export type AgentTeamsConfig = {
  /** Enable teams for this agent (default: inherits from gateway.teams.enabled). */
  enabled?: boolean;
  /** Override max teammates per team for this agent. */
  maxTeammatesPerTeam?: number;
  /** Default model for teammates spawned by this agent. */
  defaultModel?: string;
  /** Models allowed for cross-model team spawning. */
  allowedModels?: string[];
  /** Tool restrictions for teammates spawned by this agent. */
  teammateTools?: {
    allow?: string[];
    deny?: string[];
  };
};

export type AgentConfig = {
  // ... existing fields ...
  tools?: AgentToolsConfig;
  /** Per-agent Agent Teams overrides. */
  teams?: AgentTeamsConfig; // NEW
};
```

### 3. `src/config/zod-schema.agent-runtime.ts`

Add zod schema for the teams config fields. Find the `AgentEntrySchema` and add a `teams` field to it. Also add a gateway-level teams schema.

Look at how `subagents` is defined in the schema -- follow the same pattern for `teams`:

```typescript
// Agent-level teams schema
const AgentTeamsSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxTeammatesPerTeam: z.number().int().positive().optional(),
    defaultModel: z.string().optional(),
    allowedModels: z.array(z.string()).optional(),
    teammateTools: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .optional();

// Add to AgentEntrySchema:
// teams: AgentTeamsSchema,
```

For the gateway-level config, find where gateway config schemas are validated and add:

```typescript
const TeamsGatewaySchema = z
  .object({
    enabled: z.boolean().optional(),
    maxActiveTeams: z.number().int().positive().optional(),
    maxTeammatesPerTeam: z.number().int().positive().optional(),
    defaultModel: z.string().optional(),
    retentionDays: z.number().int().positive().optional(),
    storage: z
      .object({
        basePath: z.string().optional(),
        taskListFormat: z.enum(["json", "jsonl"]).optional(),
        mailboxTTLHours: z.number().positive().optional(),
      })
      .optional(),
    display: z
      .object({
        mode: z.enum(["in-process", "tmux"]).optional(),
        tmux: z
          .object({
            layout: z.enum(["tiled", "even-horizontal", "even-vertical"]).optional(),
            sessionPrefix: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .optional();
```

## Reference Files

- `src/config/types.gateway.ts` -- current GatewayConfig (244 lines)
- `src/config/types.agents.ts` -- current AgentConfig (80 lines)
- `src/config/zod-schema.agent-runtime.ts` -- agent runtime zod schemas
- RFC config: `agen-swarm-proposal/initial-rought-design.md` section 3.3

## Notes

- Teams are disabled by default (`enabled: false`). Users must explicitly opt in.
- All new config is additive. No existing fields are modified or removed.
- The `allowedModels` field on per-agent config restricts which models teammates can use when cross-model spawning is requested.
- `teammateTools.allow/deny` on per-agent config controls what tools teammates spawned by that agent can access.

## Acceptance Criteria

- [ ] `GatewayConfig` has a `teams?: TeamsGatewayConfig` field
- [ ] `AgentConfig` has a `teams?: AgentTeamsConfig` field
- [ ] Zod schemas validate all new fields correctly
- [ ] `pnpm build` passes
- [ ] Existing config tests still pass
- [ ] Loading an `openclaw.json` without `teams` still works (all new fields are optional)
