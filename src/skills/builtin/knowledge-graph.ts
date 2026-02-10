/**
 * Built-in skills: kg.add, kg.relate, kg.query, kg.traverse, kg.stats
 * Knowledge Graph — relational long-term memory for Kingston.
 * Entities (people, concepts, projects) connected by typed relationships.
 */
import { registerSkill } from "../loader.js";
import {
  kgUpsertEntity,
  kgGetEntity,
  kgAddRelation,
  kgGetRelations,
  kgSearchEntities,
  kgTraverse,
  kgStats,
} from "../../storage/store.js";

registerSkill({
  name: "kg.add",
  description:
    "Add or update an entity in the knowledge graph. Types: person, company, project, concept, place, event, skill, tool.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Entity name (e.g. 'Nicolas', 'Bastilon', 'Alpaca')" },
      entity_type: { type: "string", description: "person | company | project | concept | place | event | skill | tool" },
      properties: { type: "string", description: "JSON string of properties (optional)" },
    },
    required: ["name", "entity_type"],
  },
  async execute(args): Promise<string> {
    const name = String(args.name);
    const entityType = String(args.entity_type);
    let props: Record<string, unknown> = {};
    if (args.properties) {
      try { props = JSON.parse(String(args.properties)); } catch { return "Erreur: properties doit etre du JSON valide"; }
    }
    const id = kgUpsertEntity(name, entityType, props);
    return `Entite #${id}: ${name} (${entityType}) ajoutee/mise a jour dans le graphe.`;
  },
});

registerSkill({
  name: "kg.relate",
  description:
    "Create a relationship between two entities. E.g., Nicolas -[owns]-> Bastilon, Kingston -[uses]-> Ollama.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      from_name: { type: "string", description: "Source entity name" },
      from_type: { type: "string", description: "Source entity type" },
      to_name: { type: "string", description: "Target entity name" },
      to_type: { type: "string", description: "Target entity type" },
      relation: { type: "string", description: "Relation type (e.g. 'owns', 'uses', 'knows', 'works_with', 'part_of')" },
      weight: { type: "number", description: "Relation strength 0.0-1.0 (default 1.0)" },
    },
    required: ["from_name", "from_type", "to_name", "to_type", "relation"],
  },
  async execute(args): Promise<string> {
    const fromId = kgUpsertEntity(String(args.from_name), String(args.from_type));
    const toId = kgUpsertEntity(String(args.to_name), String(args.to_type));
    const weight = Number(args.weight) || 1.0;
    const relId = kgAddRelation(fromId, toId, String(args.relation), weight);
    return `Relation #${relId}: ${args.from_name} -[${args.relation}]-> ${args.to_name} (poids: ${weight})`;
  },
});

registerSkill({
  name: "kg.query",
  description:
    "Query the knowledge graph. Search entities by name or get all relations for an entity.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      search: { type: "string", description: "Search term (partial name match)" },
      entity_name: { type: "string", description: "Get relations for this specific entity" },
      entity_type: { type: "string", description: "Filter by entity type" },
    },
  },
  async execute(args): Promise<string> {
    // Relations for a specific entity
    if (args.entity_name) {
      const entity = kgGetEntity(String(args.entity_name), args.entity_type ? String(args.entity_type) : undefined);
      if (!entity) return `Entite "${args.entity_name}" introuvable.`;

      const rels = kgGetRelations(entity.id);
      if (rels.length === 0) return `${entity.name} (${entity.entity_type}) — aucune relation.`;

      const lines = rels.map((r) =>
        r.from_entity_id === entity.id
          ? `  -> [${r.relation_type}] ${r.to_name}`
          : `  <- [${r.relation_type}] ${r.from_name}`
      );
      const propsStr = Object.keys(entity.properties).length > 0
        ? `\nProprietes: ${JSON.stringify(entity.properties)}`
        : "";
      return `**${entity.name}** (${entity.entity_type})${propsStr}\n\nRelations (${rels.length}):\n${lines.join("\n")}`;
    }

    // Search entities
    const query = String(args.search || "");
    if (!query) return "Specifie search ou entity_name.";

    const entities = kgSearchEntities(query);
    if (entities.length === 0) return `Aucune entite trouvee pour "${query}".`;

    const lines = entities.map((e) => `  #${e.id} ${e.name} (${e.entity_type})`);
    return `**${entities.length} entite(s) trouvee(s):**\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "kg.traverse",
  description:
    "Traverse the knowledge graph from an entity, exploring connected entities up to N hops away.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      entity_name: { type: "string", description: "Starting entity name" },
      max_hops: { type: "number", description: "Max traversal depth (default 2)" },
    },
    required: ["entity_name"],
  },
  async execute(args): Promise<string> {
    const entity = kgGetEntity(String(args.entity_name));
    if (!entity) return `Entite "${args.entity_name}" introuvable.`;

    const maxHops = Number(args.max_hops) || 2;
    const results = kgTraverse(entity.id, maxHops);

    if (results.length === 0) return `${entity.name} n'a aucune connexion.`;

    const lines = results.map((r) =>
      `  ${"  ".repeat(r.depth - 1)}[${r.relation}] ${r.entity.name} (${r.entity.entity_type}) — depth ${r.depth}`
    );
    return `**Graphe depuis ${entity.name}** (${results.length} connexions, max ${maxHops} hops):\n${lines.join("\n")}`;
  },
});

registerSkill({
  name: "kg.stats",
  description: "Get knowledge graph statistics — entity count, relation count, entity types.",
  adminOnly: true,
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const stats = kgStats();
    return (
      `**Knowledge Graph:**\n` +
      `- Entites: ${stats.entities}\n` +
      `- Relations: ${stats.relations}\n` +
      `- Types: ${stats.types.join(", ") || "aucun"}`
    );
  },
});
