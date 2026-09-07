/**
 * `WERK_*` variables into config values.
 *
 * c12 never does this. `dotenv: true` loads a `.env` file into `process.env`,
 * and `$env` and `envName` select a branch inside a config file; neither turns
 * `WERK_LOG_LEVEL` into `config.logLevel`. So the environment layer is werk's
 * own, and it is a rule rather than a list — every key in the schema answers to
 * `WERK_` plus its name in screaming snake case, which is the spelling
 * `WERK_LOG_LEVEL` and `WERK_RUNTIME_DIR` already had.
 *
 * An empty variable is treated as unset, so `WERK_LOG_LEVEL= werk list` gets
 * the layer below rather than a parse error.
 */
import { CONFIG_KEYS, FIELDS, coerceLayer, type WerkConfig } from "./schema.js";

export function envLayer(
  env: NodeJS.ProcessEnv = process.env,
): Partial<WerkConfig> {
  const raw: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const value = env[FIELDS[key].env];
    if (value !== undefined && value !== "") raw[key] = value;
  }
  return coerceLayer(raw);
}

/** Which `WERK_*` variables are actually contributing, for `config sources`. */
export function envVariablesInUse(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return CONFIG_KEYS.map((key) => FIELDS[key].env).filter(
    (name) => env[name] !== undefined && env[name] !== "",
  );
}
