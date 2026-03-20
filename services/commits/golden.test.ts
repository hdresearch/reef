import { describe, expect, test } from "bun:test";
import { buildGoldenBootstrapScript } from "./golden.js";

describe("golden bootstrap", () => {
  test("builds a child-agent wrapper that sources persisted env", () => {
    const script = buildGoldenBootstrapScript();

    expect(script).toContain("cat > /usr/local/bin/punkin <<'EOF'");
    expect(script).toContain("PUNKIN_RELEASE_TAG='main'");
    expect(script).toContain('git -c advice.detachedHead=false checkout --detach "refs/tags/$PUNKIN_RELEASE_TAG"');
    expect(script).toContain(". /etc/profile.d/reef-agent.sh");
    expect(script).toContain(
      'export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    );
    expect(script).toContain("export SERVICES_DIR=/root/reef/services-active");
    expect(script).toContain("export REEF_CHILD_AGENT=true");
    expect(script).toContain('if ! grep -q "reef-agent.sh" "$shell_rc"; then');
    expect(script).toContain("printf '");
    expect(script).toContain("mkdir -p /root/workspace /root/.punkin/agent /root/.pi/agent /etc/profile.d");
    expect(script).toContain('"$PI_PATH" install /root/pi-vers');
    expect(script).toContain('"$PI_PATH" install /root/reef');
    expect(script).toContain("chmod +x /usr/local/bin/punkin 2>/dev/null || true");
    expect(script).not.toContain("if [ -x /usr/local/bin/punkin ]");
    expect(script).toContain("for pkg_root in /root/pi-vers /root/reef; do");
    expect(script).toContain('ln -sfn /root/punkin-pi/packages/tui "$pkg_root/node_modules/@mariozechner/pi-tui"');
    expect(script).toContain(
      'ln -sfn /root/punkin-pi/packages/coding-agent "$pkg_root/node_modules/@mariozechner/pi-coding-agent"',
    );
    expect(script).toContain('ln -sfn /root/punkin-pi/packages/ai "$pkg_root/node_modules/@mariozechner/pi-ai"');
    expect(script).toContain(
      'ln -sfn /root/punkin-pi/packages/agent "$pkg_root/node_modules/@mariozechner/pi-agent-core"',
    );
  });

  test("golden image does not bake in secrets or instance-specific URLs", () => {
    process.env.LLM_PROXY_KEY = "sk-vers-should-not-appear";
    process.env.VERS_API_KEY = "vers-key-should-not-appear";
    const script = buildGoldenBootstrapScript();
    expect(script).not.toContain("sk-vers-should-not-appear");
    expect(script).not.toContain("vers-key-should-not-appear");
    expect(script).not.toContain("export VERS_INFRA_URL=");
    expect(script).toContain("injected post-spawn");
    delete process.env.LLM_PROXY_KEY;
    delete process.env.VERS_API_KEY;
  });
});
