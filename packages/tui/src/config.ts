type Env = Readonly<Record<string, string | undefined>>;

export function getConfigDir(env: Env = Bun.env): string {
  const configHome = env.XDG_CONFIG_HOME?.startsWith("/")
    ? env.XDG_CONFIG_HOME
    : `${env.HOME}/.config`;

  return `${configHome}/tater`;
}
