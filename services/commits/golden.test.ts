import { describe, expect, test } from "bun:test";
import { buildGoldenBootstrapScript } from "./golden.js";

describe("golden bootstrap", () => {
  test("builds a child-agent wrapper that sources persisted env", () => {
    const script = buildGoldenBootstrapScript("https://root.example:3000");

    expect(script).toContain("cat > /usr/local/bin/punkin <<'EOF'");
    expect(script).toContain("PUNKIN_RELEASE_TAG='w/router'");
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
});
