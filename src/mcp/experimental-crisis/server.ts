#!/usr/bin/env bun

/**
 * Experimental Crisis MCP Server - Profile Modular
 *
 * Loads skills from experimental-crisis repo as MCP tools.
 * Profiles control which skills are available:
 *   - local: Full access, all skills (toxic machine)
 *   - kimi: Container-specific paths (/home/toxic/pens/estate/var/agents/output/)
 *   - generic: Portable paths, no container deps
 *
 * Skills:
 *   - sdk-auditor: Python package security auditing
 *   - infra-recon-forensics: OSINT, seed hunting, semantic analysis
 *   - seed-hunter-compat: Corpus mining, rarity scoring
 *   - stemforge: Audio forensics, stem separation
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Profile configuration
interface Profile {
  name: string;
  skillRoot: string;
  scriptRoot: string;
  pythonBin: string;
  extraEnv: Record<string, string>;
}

const PROFILES: Record<string, Profile> = {
  local: {
    name: "local",
    skillRoot: "/home/toxic/experimental-crisis/skills",
    scriptRoot: "/home/toxic/experimental-crisis/tools",
    pythonBin: "python3",
    extraEnv: {},
  },
  kimi: {
    name: "kimi",
    skillRoot: "/home/toxic/pens/estate/skills-hub",
    scriptRoot: "/home/toxic/pens/estate/var/agents/output",
    pythonBin: "/tmp/av/bin/python",
    extraEnv: {
      PYTHONPATH: "/home/toxic/pens/estate/var/agents/output:/tmp/av/lib/python3.12/site-packages",
    },
  },
  generic: {
    name: "generic",
    skillRoot:
      process.env.EXPERIMENTAL_CRISIS_SKILLS ||
      "/home/toxic/experimental-crisis/skills",
    scriptRoot:
      process.env.EXPERIMENTAL_CRISIS_SCRIPTS ||
      "/home/toxic/experimental-crisis/tools",
    pythonBin: "python3",
    extraEnv: {},
  },
};

// Active profile
const PROFILE_NAME = process.env.CRISIS_PROFILE || "generic";
const PROFILE = PROFILES[PROFILE_NAME] || PROFILES.generic;

// Skill definitions
interface SkillDef {
  name: string;
  description: string;
  tools: ToolDef[];
}

interface ToolDef {
  name: string;
  description: string;
  command: string;
  args: string[];
  timeout?: number;
}

// Load skills from profile
function loadSkills(): SkillDef[] {
  const skills: SkillDef[] = [];
  const skillRoot = PROFILE.skillRoot;

  if (!existsSync(skillRoot)) {
    console.error(`[experimental-crisis] Skill root not found: ${skillRoot}`);
    return skills;
  }

  for (const dir of readdirSync(skillRoot)) {
    const skillFile = join(skillRoot, dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const content = readFileSync(skillFile, "utf-8");

    // Parse frontmatter
    const descMatch = content.match(/description:\s*(.+?)(?:\n|$)/);
    const description = descMatch?.[1]?.trim() || `Skill from ${dir}`;

    // Define tools based on skill name
    const tools = getToolsForSkill(dir);
    if (tools.length > 0) {
      skills.push({
        name: dir,
        description,
        tools,
      });
    }
  }

  return skills;
}

function getToolsForSkill(skillName: string): ToolDef[] {
  const scriptRoot = PROFILE.scriptRoot;

  switch (skillName) {
    case "sdk-auditor":
      return [
        {
          name: "audit_package",
          description:
            "Audit a Python package for security issues, obfuscation, and API mapping",
          command: PROFILE.pythonBin,
          args: [
            join(scriptRoot, "audit_engine.py"),
            "{source_dir}",
            "{report_dir}",
          ],
          timeout: 120000,
        },
        {
          name: "fetch_package",
          description: "Fetch a package from PyPI or custom index",
          command: PROFILE.pythonBin,
          args: [
            join(scriptRoot, "fetch_pkgs.py"),
            "{output_dir}",
            "{package_names}",
          ],
          timeout: 60000,
        },
      ];
    case "infra-recon-forensics":
      return [
        {
          name: "seed_hunt",
          description:
            "Mine corpus for rare-but-recurrent tokens (codenames, credentials, endpoints)",
          command: PROFILE.pythonBin,
          args: [
            join(scriptRoot, "seed_hunter.py"),
            "{corpus_dir}",
            "--out",
            "{output_dir}",
          ],
          timeout: 180000,
        },
        {
          name: "semantic_weirdness",
          description:
            "NLTK-based semantic analysis for jargon and credential-shaped tokens",
          command: PROFILE.pythonBin,
          args: [
            join(scriptRoot, "semantic_weirdness.py"),
            "{corpus_dir}",
            "--out",
            "{output_dir}",
          ],
          timeout: 120000,
        },
      ];
    case "seed-hunter-compat":
      return [
        {
          name: "mine_seeds",
          description:
            "Multi-version seed mining with rarity x recurrence scoring",
          command: PROFILE.pythonBin,
          args: [
            join(scriptRoot, "seed_hunter.py"),
            "{corpus_dirs}",
            "--out",
            "{output_dir}",
          ],
          timeout: 180000,
        },
      ];
    case "stemforge":
      return [
        {
          name: "separate_stems",
          description: "Separate audio into stems (vocals, drums, bass, other)",
          command: PROFILE.pythonBin,
          args: [join(scriptRoot, "stems.py"), "{audio_file}", "{model}"],
          timeout: 300000,
        },
        {
          name: "analyze_audio",
          description: "Analyze audio properties (BPM, RMS, spectral centroid)",
          command: PROFILE.pythonBin,
          args: [join(scriptRoot, "ana.py"), "{audio_file}"],
          timeout: 30000,
        },
        {
          name: "measure_loudness",
          description: "Measure LUFS loudness and true peak",
          command: PROFILE.pythonBin,
          args: [join(scriptRoot, "luf.py"), "{audio_file}"],
          timeout: 30000,
        },
      ];
    default:
      return [];
  }
}

// Execute a tool
async function executeTool(
  tool: ToolDef,
  args: Record<string, string>,
): Promise<{ content: { type: string; text: string }[] }> {
  // Build command with args
  const cmdArgs = tool.args.map((arg) => {
    let result = arg;
    for (const [key, value] of Object.entries(args)) {
      result = result.replace(`{${key}}`, value);
    }
    return result;
  });

  const env = { ...process.env, ...PROFILE.extraEnv };

  try {
    const proc = Bun.spawn([tool.command, ...cmdArgs], {
      stdout: "pipe",
      stderr: "pipe",
      env,
      timeout: tool.timeout || 60000,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: exitCode === 0,
            exitCode,
            stdout: stdout.substring(0, 50000),
            stderr: stderr.substring(0, 5000),
            tool: tool.name,
            profile: PROFILE.name,
          }),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: error.message,
            tool: tool.name,
            profile: PROFILE.name,
          }),
        },
      ],
    };
  }
}

// Create MCP server
const server = new Server(
  {
    name: "experimental-crisis",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const skills = loadSkills();
  const tools = skills.flatMap((skill) =>
    skill.tools.map((tool) => ({
      name: tool.name,
      description: `[${skill.name}] ${tool.description}`,
      inputSchema: {
        type: "object" as const,
        properties: getPropertiesForTool(tool.name),
        required: getRequiredForTool(tool.name),
      },
    })),
  );

  return { tools };
});

// Get properties for tool
function getPropertiesForTool(toolName: string): Record<string, any> {
  switch (toolName) {
    case "audit_package":
      return {
        source_dir: {
          type: "string",
          description: "Path to package source directory",
        },
        report_dir: {
          type: "string",
          description: "Path to write audit report",
        },
      };
    case "fetch_package":
      return {
        output_dir: {
          type: "string",
          description: "Directory to save fetched packages",
        },
        package_names: {
          type: "string",
          description: "Comma-separated package names",
        },
      };
    case "seed_hunt":
    case "mine_seeds":
      return {
        corpus_dir: {
          type: "string",
          description: "Directory containing corpus to mine",
        },
        output_dir: {
          type: "string",
          description: "Directory to write seed results",
        },
      };
    case "semantic_weirdness":
      return {
        corpus_dir: {
          type: "string",
          description: "Directory containing corpus to analyze",
        },
        output_dir: {
          type: "string",
          description: "Directory to write analysis results",
        },
      };
    case "separate_stems":
      return {
        audio_file: { type: "string", description: "Path to audio file" },
        model: {
          type: "string",
          description: "Model to use (htdemucs, htdemucs_ft)",
          default: "htdemucs",
        },
      };
    case "analyze_audio":
    case "measure_loudness":
      return {
        audio_file: { type: "string", description: "Path to audio file" },
      };
    default:
      return {};
  }
}

function getRequiredForTool(toolName: string): string[] {
  switch (toolName) {
    case "audit_package":
      return ["source_dir", "report_dir"];
    case "fetch_package":
      return ["output_dir", "package_names"];
    case "seed_hunt":
    case "mine_seeds":
      return ["corpus_dir", "output_dir"];
    case "semantic_weirdness":
      return ["corpus_dir", "output_dir"];
    case "separate_stems":
      return ["audio_file"];
    case "analyze_audio":
    case "measure_loudness":
      return ["audio_file"];
    default:
      return [];
  }
}

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const skills = loadSkills();

  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (tool.name === name) {
        return executeTool(tool, args as Record<string, string>);
      }
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: `Unknown tool: ${name}` }),
      },
    ],
    isError: true,
  };
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[experimental-crisis] MCP server started (profile: ${PROFILE.name})`,
);
