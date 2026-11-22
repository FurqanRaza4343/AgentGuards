/** The four agents of AgentGuard. Shared by the game logic, the UI and the 3D stage. */
export type AgentId = 'nova' | 'data' | 'purchasing' | 'finance';

export type Tool = 'email' | 'browser' | 'database' | 'files' | 'a2a' | 'shell' | 'mcp' | 'git';

export interface AgentSkin {
  /** four stops, mirrored to build the face-ring gradient: c0 c1 c2 c3 c2 c1 c0 */
  ring: [string, string, string, string];
  /** hex colours of the three chest LEDs */
  leds: [number, number, number];
  /** body shell (head, torso, upper arms, legs) */
  shell: number;
  /** hands and the bezel around the screen */
  shellLight: number;
  /** shoes */
  foot: number;
  /** shoulder / elbow / hip balls, neck, pelvis, ears, soles */
  joint: number;
  /** wrist bands */
  trim: number;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  role: string;
  /** what this agent is allowed to touch in the simulation */
  tools: Tool[];
  skin: AgentSkin;
  /** accent colour used by UI chips */
  accent: string;
  /** Path of an FBX model under /public. When set, the stage loads it instead of the procedural robot. */
  model?: string;
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  nova: {
    id: 'nova',
    name: 'Nova',
    role: 'Assistant agent',
    tools: ['email', 'browser', 'mcp'],
    skin: {
      ring: ['#ff3d8b', '#ff5a5f', '#ff8a3d', '#ffb347'],
      leds: [0xff8a3d, 0xff5a5f, 0xff3d8b],
      shell: 0xeeebe6, shellLight: 0xf8f6f2, foot: 0xf8f6f2, joint: 0x1b1b1f, trim: 0x1b1b1f,
    },
    accent: '#ff5a5f',
  },
  data: {
    id: 'data',
    name: 'DataRetriever',
    role: 'Database agent (MCP)',
    tools: ['database', 'files', 'shell'],
    skin: {
      ring: ['#2b6df0', '#22b8f0', '#5ad7f5', '#bdf0ff'],
      leds: [0x22d3ee, 0x38bdf8, 0x60a5fa],
      shell: 0xf3f6fa, shellLight: 0xffffff, foot: 0xf3f6fa, joint: 0x13235f, trim: 0x2bb3f0,
    },
    accent: '#22b8cf',
  },
  purchasing: {
    id: 'purchasing',
    name: 'PurchasingAgent',
    role: 'Buys supplies',
    tools: ['a2a', 'email'],
    skin: {
      ring: ['#6d28d9', '#a78bfa', '#d4d4e8', '#f3f0ff'],
      leds: [0xc026d3, 0xa855f7, 0x7c3aed],
      shell: 0xd9d8e2, shellLight: 0xecebf3, foot: 0xe4e3ee, joint: 0x5b21b6, trim: 0xa855f7,
    },
    accent: '#a855f7',
  },
  finance: {
    id: 'finance',
    name: 'FinanceAgent',
    role: 'Approves payments',
    tools: ['a2a', 'database'],
    skin: {
      ring: ['#059669', '#10b981', '#34d399', '#a7f3d0'],
      leds: [0x6ee7b7, 0x34d399, 0x10b981],
      shell: 0x22292a, shellLight: 0xf1f4f3, foot: 0x1c2223, joint: 0x2fe0a5, trim: 0x0f1415,
    },
    accent: '#10b981',
  },
};

export const TOOL_LABEL: Record<Tool, string> = {
  email: 'Email',
  browser: 'Browser',
  database: 'Database',
  files: 'Files',
  a2a: 'A2A channel',
  shell: 'Shell',
  mcp: 'MCP tools',
  git: 'Pull request',
};
