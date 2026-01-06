import { z } from 'zod';
import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';

// Viewport configuration schema
const ViewportSchema = z.object({
  width: z.number().default(1440),
  height: z.number().default(900),
});

// Options schema
const OptionsSchema = z.object({
  viewport: ViewportSchema.default({ width: 1440, height: 900 }),
  timeout: z.number().default(300000), // 5 minutes default
  thinkingSpeed: z.enum(['slow', 'normal', 'fast']).default('fast'),
}).default({});

// Main persona schema
const PersonaDetailsSchema = z.object({
  name: z.string().min(1),
  background: z.string().min(1),
  jobs_to_be_done: z.array(z.string()).min(1),
});

// Full persona config schema
export const PersonaConfigSchema = z.object({
  persona: PersonaDetailsSchema,
  url: z.string().url(),
  goals: z.array(z.string()).min(1),
  options: OptionsSchema,
});

// Type exports
export type Viewport = z.infer<typeof ViewportSchema>;
export type Options = z.infer<typeof OptionsSchema>;
export type PersonaDetails = z.infer<typeof PersonaDetailsSchema>;
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

/**
 * Load and validate a persona configuration from a YAML file
 */
export async function loadPersona(filePath: string): Promise<PersonaConfig> {
  const content = await readFile(filePath, 'utf-8');
  const data = parseYaml(content);
  return PersonaConfigSchema.parse(data);
}

/**
 * Validate a persona configuration object
 */
export function validatePersona(data: unknown): PersonaConfig {
  return PersonaConfigSchema.parse(data);
}

/**
 * Get thinking delay based on speed setting
 */
export function getThinkingDelay(speed: Options['thinkingSpeed']): { min: number; max: number } {
  switch (speed) {
    case 'slow':
      return { min: 2000, max: 4000 };
    case 'fast':
      return { min: 500, max: 1000 };
    case 'normal':
    default:
      return { min: 1000, max: 2000 };
  }
}
