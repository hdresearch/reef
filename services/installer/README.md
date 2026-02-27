# installer

Install, update, and remove service modules at runtime. Three install modes: git (clone), local (symlink), and fleet-to-fleet (tarball over HTTP).

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/installer/install` | Install a service |
| `POST` | `/installer/update` | Update an installed service |
| `POST` | `/installer/remove` | Remove an installed service |
| `GET` | `/installer/installed` | List installed packages |

## Install modes

**Git** — clones the repo, runs `bun install` if `package.json` exists:
```json
{ "source": "github-user/repo" }
{ "source": "https://github.com/user/repo.git@v1.0" }
{ "source": "git@github.com:user/repo" }
```

**Local** — creates a symlink (good for development):
```json
{ "source": "/path/to/my-service" }
```

**Fleet-to-fleet** — pulls a tarball from another reef instance:
```json
{ "from": "https://other-reef:3000", "name": "some-service", "token": "their-auth-token" }
```

## Update

Re-pulls from the original source (git pull or fleet re-fetch):
```json
{ "name": "some-service" }
```

Local symlinks can't be updated (they're already live).

## How it works

- Installed packages are tracked in `{servicesDir}/.installer.json`
- Auth tokens are never stored — pass `token` on every fleet request
- After install/update, the module is auto-loaded via `ctx.loadModule()`
- On remove, the module is unloaded and the directory deleted
