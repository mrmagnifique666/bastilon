/**
 * Agent bootstrap — registers and starts all configured agents.
 * Called from index.ts after the scheduler starts.
 */
import { registerAgent, stopAllAgents } from "./registry.js";
import { createScoutConfig } from "./definitions/scout.js";
import { createAnalystConfig } from "./definitions/analyst.js";
import { createLearnerConfig } from "./definitions/learner.js";
import { createExecutorConfig } from "./definitions/executor.js";
import { createTradingMonitorConfig } from "./definitions/trading-monitor.js";
import { createSentinelConfig } from "./definitions/sentinel.js";
import { createMindConfig } from "./definitions/mind.js";
import { createNightWorkerConfig } from "./definitions/night-worker.js";
import { log } from "../utils/log.js";

export function startAgents(): void {
  log.info("[agents] Bootstrapping agents...");

  const scoutConfig = createScoutConfig();
  registerAgent(scoutConfig);

  const analystConfig = createAnalystConfig();
  registerAgent(analystConfig);

  const learnerConfig = createLearnerConfig();
  registerAgent(learnerConfig);

  const executorConfig = createExecutorConfig();
  registerAgent(executorConfig);

  const tradingMonitorConfig = createTradingMonitorConfig();
  registerAgent(tradingMonitorConfig);

  const sentinelConfig = createSentinelConfig();
  registerAgent(sentinelConfig);

  const mindConfig = createMindConfig();
  registerAgent(mindConfig);

  const nightWorkerConfig = createNightWorkerConfig();
  registerAgent(nightWorkerConfig);

  log.info("[agents] Agent bootstrap complete (8 agents)");
}

export function shutdownAgents(): void {
  stopAllAgents();
}
