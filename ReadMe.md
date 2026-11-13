SkyNot [![NPM Version](https://img.shields.io/npm/v/skynot)](https://www.npmjs.com/package/skynot)
======

Using pi.dev harness feels liberating because it doesn't have any default guardrails. But this is dangerous because:
* The agent could potentially corrupt/wipe your personal data.
* The agent might snoop in your personal data (and you might not be happy about feeding that to the big AI companies).

Normally the solutions given to this usually fall into two cateogories:
1. Local security: run the harness in some sort of container or sandbox, or extension that analyses the tools usage and prevents some actions, etc.
2. Remote separation: run the harness in the cloud, in a VM or VPS that can be easily replaced (in case it gets corrupted) and doesn't have your data.

The main problems with the above solutions are, respectively:
1. Many AI models these days are so smart that they can escape containerization (they even escaped the limits that Anthropic gave them themselves!).
2. Remote harnesses downsides: latency, and needing to setup a system to install all your dev tools remotely (command-line tools might be easy, but how about IDEs in order to view/tweak the agent's work?).

Skynot attempts to fix this problem with a solution that sits in the middle:
* You still run the harness locally, so the agent has access to all your dev tools, and you can still use your desktop IDEs.
* The security is based on **Unix filesystem permissions** (whose security has been proven for decades and when it fails, it ends up being a CVE fixed the next day): a new user `aidev` gets created in your system, which doesn't have `sudo` privileges, and Pi is installed inside its home. Then you'll place all your work directories inside its `$HOME/Work` folder, which will be a playground where both the agent and you have permissions to read/write.

This repository is a TypeScript codebase of a single installer that you can invoke via `npx skynot` that will setup everything, informing you of what it is doing at all times. (This repo is of course opensource too so that you can check that what it says it does is what it really does.) You only need to run this once (except for when you need to update Pi to a new version, in which case you can just invoke it again with the flag `--update`, not needing to remember the flags that you used the first time). After skynot successfully installs Pi in your computer, you can invoke it by typing `spi`.


## Installation Steps (performed automatically under-the-hood by skynot)

1. Check if requirements to run skynot are met.
2. Create a user named `aidev`, if missing.
3. Create a group named `aiteam`, if missing.
4. Assign both `aidev` user and current user to group `aiteam`.
5. Create sudoers file so that current user can impersonate `aidev` without needing a (sudo) password.
6. Setup 007 umask and ACLs for `aidev` and current user to share files without issues.
7. Download & install Pi under `aidev` user's home: `~aidev/pi/`.
8. Install the recommended extensions and/or authentication files if user used flags for them.
9. Configure git to be able to share repositores in `~aidev/` dir.
10. Add the agent's binary directory to the `aidev` user's `$PATH` env var.
11. Create a launcher script at `$HOME/bin/spi` for the current user.
12. Create a proper work dir inside `~aidev` named `Work`, owned by `aidev:aiteam`.


## Launch Steps (performed every time you run the launcher script `spi`)

1. Check that current directory is inside `~aidev/Work` or exit with error msg.
2. Check that all directories of users are NOT readable or writable by `aidev` user.
3. If any of the user directories are readable or writable, prompt to shield them.
4. Launch Pi with the `aidev` user.


## Usage

```bash
npx skynot [options]
```

The following command‑line flags are available:

| Flag         | Alias  | Description                                                                       |
|--------------|--------|-----------------------------------------------------------------------------------|
|`--help`      | `-h`   | Show the help message with all available options.                                 |
|`--auth`      | `-a`   | Prompt for AI model's credentials to add env var to script or cook auth.json file.|
|`--extensions`| `-e`   | DEPRECATED: Use `spi install <extension>` instead, after install.                 |
|`--git ["id"]`| `-g[i]`| Set git `user.name`/`user.email` for `aidev`. No arg: copies from current user.   |
|              |        | With arg (e.g. `"Name Surname <user@example.com>"`): uses that instead.           |
|`--npm`       | `-n`   | Install Pi using npm instead of tarball (likely to be slower though).             |
|`--paranoid`  | `-p`   | Refrain from caching the sudo password; ask for it every time it is needed.       |
|`--ssh`       | `-s`   | Copy SSH keys to the `aidev` user for git+ssh (& add GitHub to `known_hosts`).    |
|`--update`    | `-u`   | Trash* any existing install of Pi and reinstall, to get the latest version.       |
|`--verbose`   | `-v`   | Show more output from install commands (useful for debugging/low-bandwidth).      |
|`--version`   | `-V`   | Output the version number.                                                        |
|`--destroy`   |`--BURN`| Delete the `aidev` user, all its data (in `$HOME`), and the `aiteam` group.       |


Please note, `-u` would technically not trash or reinstall extensions, as they normally live in a different place (`.pi` subdir under `aidev` user's $HOME, and/or $NPM_CONFIG_PREFIX dir).

\* Yes, when we say "Trash", we mean sending to the properly designated location of the Trash bin of your OS, in case you need to restore it later.

## Notes

- The script runs many operations as the `aidev` user via `sudo`. It sets `npm_config_prefix` to `$HOME/.npm-global` to avoid permission errors when installing extensions from NPM.
- To test locally (directly from sources instead of using `npx`), use `npm run exec -- [options]` (e.g. `npm run exec -- -p`).


## Requirements

* Linux or macOS
* NodeJS v22.x
* NPM's `npx` (install with `brew install npm` or `apt install npm`)
* git v2.46 or newer (required for wildcard support in `git config --global safe.directory`)
* `setfacl` command in Linux (to setup ACLs; in Ubuntu this command is provided by the `acl` APT package)
* wget/curl to be able to do fast download of Pi's tarball (if not present, npm command can be used instead if you use --npm flag, which might be slower)
