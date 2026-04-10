SkyNot
=======

Ever tempted to use or try out the infamous `pi-coding-agent` but got put off by its lack of out-of-the-box sandbox?

Some people use and/or develop guardrails extensions or poor-man sandboxing solutions; others just deploy it to their VPS so that any potential damage is contained.

But the virtue is somewhere in the middle:
- No need to go to the extreme of complicated cloud deploys to just try out some clanking business.
- No need to setup complicated tweaks or plugins that may give you a false sense of security, or too many permissions issues for your clanker to be productive.

Why not just use the unix model? Give pi a user profile in your system, a $HOME where to place its git repositories and you're off to the races.

This repository is just a quick NPX tool that helps you set up this ideal approach: run it with a simple `npx skynot` and it will guide you through the process and ask you for sudo permissions in each step that it requires, informing you of what it is doing at all times.

(This repo is of course opensource too so that you can check that what it says it does is what it really does.)
