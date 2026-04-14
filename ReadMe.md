SkyNot [![NPM Version](https://img.shields.io/npm/v/skynot)](https://www.npmjs.com/package/skynot)
======

Ever tempted to use or try out the infamous `pi-coding-agent` but got put off by its lack of out-of-the-box sandbox?

Some people use and/or develop guardrails extensions or poor-man sandboxing solutions; others just deploy it to their VPS so that any potential damage is contained.

But the virtue is somewhere in the middle:
- No need to go to the extreme of complicated cloud deploys to just try out some clanking business.
- No need to setup potentially-unsafe tweaks or plugins that may give you a false sense of security, or too many permissions issues for your clanker to be productive.

Why not just use the **unix** model? Give Pi a user in your system, a $HOME where to place its git repositories and you're off to the races.

This repository is just a quick `npx` tool that helps you set up this ideal approach: run it with a simple `npx skynot` and it will guide you through the process and ask you for sudo permissions in each step that it requires, informing you of what it is doing at all times.

(This repo is of course opensource too so that you can check that what it says it does is what it really does.)


## Installation Steps (performed automatically under-the-hood)

1. Create a user named `pi`, if missing.
2. Create a group named `aiteam`, if missing.
3. Download & install Pi under `pi` user's home: `~pi/pi/`.
4. Install the recommended extensions and/or authentication files if user used flags for them.
5. Add the agent's binary directory to the `pi` user's `$PATH` env var.
6. Create a launcher script at `$HOME/bin/pi` for the current user.
7. Create a proper work dir inside `~pi` named `Work`, owned by `pi:aiteam`.
8. Assign both `pi` user and current user to group `aiteam`.


## Usage

```bash
npx skynot [options]
```

The following command‑line flags are available:

| Flag         | Alias  | Description                                                                       |
|--------------|--------|-----------------------------------------------------------------------------------|
|`--help`      | `-h`   | Show the help message with all available options.                                 |
|`--auth`      | `-a`   | Ask about auth details (provider name and API key) to add it to launcher script.  |
|`--extensions`| `-e`   | After installing Pi, also install recommended extensions.                         |
|`--npm`       | `-n`   | Install Pi using npm instead of tarball.                                          |
|`--paranoid`  | `-p`   | Never cache the sudo password; ask for it every time it is needed.                |
|`--ssh`       | `-s`   | Copy SSH keys to the `pi` user for git+ssh (& add GitHub to `known_hosts`).       |
|`--update`    | `-u`   | Wipe any previous existing install of Pi and reinstall, to get the latest version.|
|`--verbose`   | `-v`   | Show more output from install commands (useful for debugging/low-bandwidth).      |
|`--version`   | `-V`   | Output the version number.                                                        |
|`--destroy`   |`--BURN`| Delete the `pi` user, all its data (in `$HOME`), and the `aiteam` group.          |


Please note, `-u` would technically not wipe or reinstall extensions, as they normally live in a different place (`.pi` subdir under `pi` user's $HOME, and/or $NPM_CONFIG_PREFIX dir).


## Notes

- The script runs many operations as the `pi` user via `sudo`. It sets `npm_config_prefix` to `$HOME/.npm-global` to avoid permission errors when installing extensions from NPM.
- To test locally (directly from sources instead of using `npx`), use `npm run exec -- [options]` (e.g. `npm run exec -- -e`).
