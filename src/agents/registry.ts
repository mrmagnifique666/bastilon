/**
 * Agent registry — manages all active agents.
 * Provides CRUD operations for Kingston to dynamically create/stop agents.
 */
import { Agent, type AgentConfig, type AgentStats } from "./base.js";
import { log } from "../utils/log.js";

const agents = new Map<string, Agent>();

/** Register and optionally start an agent */
export function registerAgent(config: AgentConfig, autoStart = true): Agent {
  if (agents.has(config.id)) {
    log.warn(`[agents] Agent "${config.id}" already exists — stopping old instance`);
    agents.get(config.id)!.stop();
  }

  const agent = new Agent(config);
  agents.set(config.id, agent);
  log.info(`[agents] Registered agent: ${config.id} (${config.name})`);

  if (autoStart && config.enabled) {
    agent.start();
  }

  return agent;
}

/** Get an agent by ID */
export function getAgent(id: string): Agent | undefined {
  return agents.get(id);
}

/** List all agents */
export function listAgents(): AgentStats[] {
  return Array.from(agents.values()).map((a) => a.getStats());
}

/** Stop and remove an agent */
export function removeAgent(id: string): boolean {
  const agent = agents.get(id);
  if (!agent) return false;
  agent.stop();
  agents.delete(id);
  log.info(`[agents] Removed agent: ${id}`);
  return true;
}

/** Stop all agents */
export function stopAllAgents(): void {
  for (const agent of agents.values()) {
    agent.stop();
  }
  log.info(`[agents] Stopped all ${agents.size} agents`);
}

/** Start all enabled agents */
export function startAllAgents(): void {
  for (const agent of agents.values()) {
    agent.start();
  }
  log.info(`[agents] Started all enabled agents`);
}
