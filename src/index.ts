import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { promisify } from 'util';
import * as os from 'os';
import { Command } from 'commander';
import { Option, Some, Nothing } from 'fp-sdk';
import pkg from '../package.json';

const execAsync = promisify(exec);

const AGENT_PACKAGE = '@mariozechner/pi-coding-agent';
const AGENT_USER = 'pi';
const LAUNCHER_SCRIPT_FILENAME = 'pi';
const AGENT_GROUP_NAME = "aiteam";


function getShellRcFile(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return '.zshrc';
  }
  return '.bashrc';
}

function getPiHome(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return `/Users/${AGENT_USER}`;
  }
  return `/home/${AGENT_USER}`;
}

function getPiInstallDir(): string {
  return `${getPiHome()}/pi`;
}

async function askQuestion(query: string, silent = false): Promise<string> {
  if (silent) {
    return new Promise<string>((resolve) => {
      process.stdout.write(query);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf-8');
      let input = '';
      const onData = (char: string) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(wasRaw);
          stdin.pause();
          process.stdout.write('\n');
          resolve(input);
        } else if (char === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(wasRaw);
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      };
      stdin.on('data', onData);
    });
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function runSudoWithPassword(command: string, password: string, asUser?: string, verbose?: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sudoArgs = ['-S', '-k'];
    if (asUser) {
      sudoArgs.push('-u', asUser);
    }
    sudoArgs.push('bash', '-c', command);
    const child = spawn('sudo', sudoArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // this is a workaround to errors like 'shell-init: error retrieving current directory: getcwd: cannot access parent directories: Permission denied
      cwd: '/tmp',
    });
    child.stdin.write(password + '\n');
    child.stdin.end();

    let stderr = '';
    if (verbose) {
      child.stdout.pipe(process.stdout);
    }
    child.stderr.on('data', (data: Buffer) => {
      const line = data.toString();
      // Filter out sudo's own password prompt
      if (!line.includes('Password:') && !line.includes('password for')) {
        stderr += line;
        if (verbose) {
          process.stderr.write(line);
        }
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Sanitize: never include the password in error messages
        let safeStderr = stderr;
        if (password !== "") {
          const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          safeStderr = stderr.replace(new RegExp(escaped, 'g'), '***');
        }
        reject(new Error(`sudo command '${command}' failed (exit code ${code}): ${safeStderr.trim()}`));
      }
    });
  });
}

// Cached sudo password so we only ask once
let cachedSudoPassword: Option<string> = Nothing;

// When true, never cache the sudo password — ask every time
let paranoidMode = false;

async function askSudoPasswordAndRun(command: string, reason: string, asUser?: string, verbose?: boolean): Promise<void> {
  const MAX_SUDO_RETRIES = 3;
  if (!paranoidMode && cachedSudoPassword instanceof Some) {
    await runSudoWithPassword(command, cachedSudoPassword.value, asUser, verbose);
    return;
  }
  for (let attempt = 1; attempt <= MAX_SUDO_RETRIES; attempt++) {
    const password = await askQuestion(`Enter sudo password (${reason}) [exact command: \`${command}\`]: `, true);
    try {
      // Validate the password with a trivial command first
      await runSudoWithPassword('ls /', password);
    } catch (e) {
      if (attempt < MAX_SUDO_RETRIES) {
        console.error('Incorrect password, please try again.');
        continue;
      } else {
        throw new Error(`Failed after ${MAX_SUDO_RETRIES} attempts. Aborting.`);
      }
    }
    if (!paranoidMode) {
      cachedSudoPassword = new Some(password);
    }

    // Password is valid, now run the actual command
    await runSudoWithPassword(command, password, asUser, verbose);
    return;
  }
}

async function runAsPi(command: string, verbose?: boolean): Promise<void> {
  const piHome = getPiHome();
  // Set HOME and cd to the agent user's home to avoid inheriting the current user's
  // working directory (which the agent user can't access) and npm cache.
  const wrappedCommand = `export HOME=${piHome} && export npm_config_prefix=${piHome}/.npm-global && cd ${piHome} && ${command}`;
  await askSudoPasswordAndRun(wrappedCommand, `required to run as '${AGENT_USER}' user`, AGENT_USER, verbose);
}

async function userExists(username: string): Promise<boolean> {
  try {
    await execAsync(`id -u ${username}`);
    return true;
  } catch {
    return false;
  }
}

async function groupExists(groupName: string): Promise<boolean> {
  try {
    const platform = os.platform();
    if (platform === 'darwin') {
      await execAsync(`dscl . -read /Groups/${groupName}`);
    } else {
      await execAsync(`getent group ${groupName}`);
    }
    return true;
  } catch {
    return false;
  }
}

async function ensurePiUser(): Promise<void> {
  const exists = await userExists(AGENT_USER);
  if (exists) {
    console.log(`User "${AGENT_USER}" already exists.`);
    return;
  }
  console.log(`Creating user "${AGENT_USER}"...`);
  const piHome = getPiHome();
  const platform = os.platform();
  if (platform === 'darwin') {
    await askSudoPasswordAndRun(
      `sysadminctl -addUser ${AGENT_USER} -home ${piHome} -shell /bin/zsh && createhomedir -c -u ${AGENT_USER} 2>/dev/null; mkdir -p ${piHome} && chown ${AGENT_USER}:staff ${piHome}`,
      'required to create user',
    );
  } else {
    await askSudoPasswordAndRun(
      `useradd -m -s /bin/bash ${AGENT_USER}`,
      'required to create user',
    );
  }
  console.log(`User "${AGENT_USER}" created.`);
}

async function installAgent(verbose?: boolean): Promise<void> {
  const installDir = getPiInstallDir();
  const [scope, name] = AGENT_PACKAGE.split('/');
  const packageDir = path.join(installDir, 'node_modules', scope, name);
  if (fs.existsSync(packageDir)) {
    console.log(`${AGENT_PACKAGE} is already installed, skipping.`);
    return;
  }
  console.log(`Installing ${AGENT_PACKAGE} into ${installDir}...`);
  const npmLogLevel = verbose ? ' --loglevel info' : '';
  const cmd = `mkdir -p ${installDir} && cd ${installDir} && npm install${npmLogLevel} ${AGENT_PACKAGE}`;
  await runAsPi(cmd, verbose);
  console.log('Package installed.');
}

async function updatePath(): Promise<void> {
  const rcFile = getShellRcFile();
  const piHome = getPiHome();
  const line = "export PATH=\$HOME/pi/node_modules/.bin:\$PATH";
  const rcPath = `${piHome}/${rcFile}`;

  // Check locally if the line is already present
  if (fs.existsSync(rcPath)) {
    const content = fs.readFileSync(rcPath, 'utf-8');
    if (content.includes(line)) {
      console.log(`${AGENT_USER}'s PATH already configured in ${rcFile}, skipping.`);
      return;
    }
  }

  console.log(`Adding agent binary directory to ${AGENT_USER}'s PATH via ${rcFile}...`);
  const checkCmd = `grep -Fx '${line}' ${rcPath} 2>/dev/null || echo '${line}' >> ${rcPath}`;
  await runAsPi(checkCmd);
  console.log(`${rcFile} updated.`);
}

async function createLauncherScript(): Promise<void> {
  const currentUserHome = os.homedir();
  const binDir = path.join(currentUserHome, 'bin');
  const scriptPath = path.join(binDir, LAUNCHER_SCRIPT_FILENAME);
  const installDir = getPiInstallDir();

  console.log(`Creating launcher script at ${scriptPath}...`);

  // Create ~/bin/ if it doesn't exist
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const piHome = getPiHome();
  const platform = os.platform();
  const homeBase = platform === 'darwin' ? '/Users' : '/home';

  // Write the launcher shell script with permission checks
  const scriptContent = `#!/bin/bash

CURRENT_DIR=$PWD

echo "About to launch pi-coding-agent..."

# Check permissions of other users' home directories
EXPOSED_DIRS=()
HOME_BASE="${homeBase}"
PI_HOME="${piHome}"

for user_home in "$HOME_BASE"/*/; do
  # Skip ${AGENT_USER}'s own home
  if [ "$user_home" = "$PI_HOME/" ]; then
    continue
  fi

  # Check if group or others have any permissions (r, w, or x)
  perms=$(stat -f "%Sp" "$user_home" 2>/dev/null || stat -c "%A" "$user_home" 2>/dev/null)
  if [ -z "$perms" ]; then
    continue
  fi

  # Extract group and others permissions (characters 5-10 of e.g. drwxr-xr-x)
  group_others="\${perms:4:6}"
  # Check if any of group/others have r, w, or x
  if echo "$group_others" | grep -q '[rwx]'; then
    # On macOS, handle /Users/Shared separately (it's world-accessible by default)
    if [ "$user_home" = "/Users/Shared/" ]; then
      echo "NOTE: /Users/Shared is world-accessible. This is a macOS default, but you may want to restrict it manually if it contains sensitive data."
      read -n 1 -s -r -p "Press any key to continue..."
      echo ""
    else
      EXPOSED_DIRS+=("$user_home")
    fi
  fi
done

if [ \${#EXPOSED_DIRS[@]} -gt 0 ]; then
  echo "WARNING: The following user home directories are accessible by other users (including '${AGENT_USER}' user):"
  for dir in "\${EXPOSED_DIRS[@]}"; do
    echo "  $dir"
  done
  echo ""
  read -p "Would you like to shield these directories? (recommended) [Y/n]" answer
  answer=\${answer:-Y}
  if [[ "$answer" =~ ^[Yy] ]]; then
    for dir in "\${EXPOSED_DIRS[@]}"; do
      sudo chmod go-rwx "$dir"
      echo "Shielded: $dir"
    done
    echo "Done."
  fi
  echo ""
fi

echo "Launching pi-coding-agent with ${AGENT_USER} user (sudo is required to impersonate '${AGENT_USER}' user)..."
exec sudo -i -u ${AGENT_USER} bash -c "export npm_config_prefix=$PI_HOME/.npm-global && cd $CURRENT_DIR && ${installDir}/node_modules/.bin/pi"
`;
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  console.log('Launcher script created.');

  // Add $HOME/bin to the current user's PATH via their rc file if not already present
  const rcFile = getShellRcFile();
  const rcPath = path.join(currentUserHome, rcFile);
  const pathLine = 'export PATH="$HOME/bin:$PATH"';

  let rcContent = '';
  if (fs.existsSync(rcPath)) {
    rcContent = fs.readFileSync(rcPath, 'utf-8');
  }

  if (!rcContent.includes(pathLine)) {
    console.log(`Adding $HOME/bin to PATH in ${rcFile}...`);
    fs.appendFileSync(rcPath, `\n${pathLine}\n`);
    console.log(`${rcFile} updated.`);
  } else {
    console.log(`$HOME/bin already in PATH (${rcFile}).`);
  }
}

async function createMacOsGroup(sudoReason: string, freeGroupIdFindingCount: number): Promise<void> {
  if (freeGroupIdFindingCount == 0) {
    await askSudoPasswordAndRun(`dscl . -create /Groups/${AGENT_GROUP_NAME}`, sudoReason);
    console.log(`Group "${AGENT_GROUP_NAME}" created without group assignment yet`);
  }

  const maxTriesForFindingAFreeGroupId = 50;

  // some SO post recommends giving gids between 100-499: https://superuser.com/a/1842207
  const gid = 444 - freeGroupIdFindingCount;

  try {
    await askSudoPasswordAndRun(`dscl . -create /Groups/${AGENT_GROUP_NAME} gid ${gid}`, sudoReason);
    console.log(`Group "${AGENT_GROUP_NAME}" created (group ID: ${gid}).`);
  } catch (createErr: unknown) {
    const errMsg = createErr instanceof Error ? createErr.message : String(createErr);
    if (errMsg.includes('eDSRecordAlreadyExists') || errMsg.includes('already exists')) {
      if (freeGroupIdFindingCount > maxTriesForFindingAFreeGroupId) {
        throw Error("Could not find a free gid for new group");
      } else {
        return createMacOsGroup(sudoReason, freeGroupIdFindingCount + 1);
      }
    }
  }
}

async function setupWorkDir(): Promise<string> {
  const piHome = getPiHome();
  const workDir = path.join(getPiHome(), 'Work');
  const currentUser = os.userInfo().username;
  const platform = os.platform();

  // Create group if it doesn't exist
  try {
    if (platform === 'darwin') {
      await execAsync(`dscl . -read /Groups/${AGENT_GROUP_NAME}`);
    } else {
      await execAsync(`getent group ${AGENT_GROUP_NAME}`);
    }
    console.log(`Group "${AGENT_GROUP_NAME}" already exists.`);
  } catch {
    console.log(`Creating group "${AGENT_GROUP_NAME}"...`);
    const reason = `required to create ${AGENT_GROUP_NAME} group`;
    if (platform === 'darwin') {
      await createMacOsGroup(reason, 0);
    } else {
      await askSudoPasswordAndRun(`groupadd ${AGENT_GROUP_NAME}`, reason);
      console.log(`Group "${AGENT_GROUP_NAME}" created.`);
    }
  }

  // Add users to AI group
  for (const user of [AGENT_USER, currentUser]) {
    try {
      const { stdout } = await execAsync(`id -nG ${user}`);
      if (stdout.split(/\s+/).includes(AGENT_GROUP_NAME)) {
        console.log(`User "${user}" is already in group "${AGENT_GROUP_NAME}".`);
        continue;
      }
    } catch {
      // user might not exist yet or id failed, try to add anyway
    }
    console.log(`Adding user "${user}" to group "${AGENT_GROUP_NAME}"...`);
    if (platform === 'darwin') {
      await askSudoPasswordAndRun(`dseditgroup -o edit -a ${user} -t user ${AGENT_GROUP_NAME}`, `required to add ${user} to ${AGENT_GROUP_NAME} group`);
    } else {
      await askSudoPasswordAndRun(`usermod -aG ${AGENT_GROUP_NAME} ${user}`, `required to add ${user} to ${AGENT_GROUP_NAME} group`);
    }
    console.log(`User "${user}" added to group "${AGENT_GROUP_NAME}".`);
  }

  console.log(`Setting up group permissions...`);
  await askSudoPasswordAndRun(`chown ${AGENT_USER}:${AGENT_GROUP_NAME} ${piHome} && chmod g+rwx ${piHome}`, `required to set ${AGENT_USER}'s home to belong to ${AGENT_GROUP_NAME} group`);

  // Create work directory owned by pi:${AGENT_GROUP_NAME} with group rwx
  console.log(`Setting up work directory at ${workDir}...`);
  await askSudoPasswordAndRun(`mkdir -p ${workDir} && chown ${AGENT_USER}:${AGENT_GROUP_NAME} ${workDir} && chmod g+rwx ${workDir}`, 'required to set up work directory');
  console.log('Work directory ready.');

  return workDir;
}

const RECOMMENDED_EXTENSIONS = ['npm:awto-pi-lot'];

async function installExtensions(verbose?: boolean): Promise<void> {
  const installDir = getPiInstallDir();
  for (const ext of RECOMMENDED_EXTENSIONS) {
    console.log(`Installing recommended extension: ${ext}...`);
    await runAsPi(`${installDir}/node_modules/.bin/pi install ${ext}`, verbose);
    console.log(`Extension ${ext} installed.`);
  }
}

async function launchAgent(): Promise<void> {
  const scriptPath = path.join(os.homedir(), 'bin', 'pi');
  const child = spawn(scriptPath, [], { stdio: 'inherit' });
  return new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pi-coding-agent exited with code ${code}`));
      }
    });
  });
}

async function configureAuth(): Promise<void> {
  const providerName = await askQuestion('Enter provider name: ');
  if (!providerName.trim()) {
    console.error('Provider name cannot be empty. Skipping auth configuration.');
    return;
  }
  const apiKey = await askQuestion('Enter API key: ');
  if (!apiKey.trim()) {
    console.error('API key cannot be empty. Skipping auth configuration.');
    return;
  }

  const authData = {
    [providerName.trim()]: {
      type: 'api_key',
      key: apiKey.trim(),
    },
  };

  const piHome = getPiHome();
  const agentDir = path.join(piHome, '.pi', 'agent');
  const authFilePath = path.join(agentDir, 'auth.json');
  const authJson = JSON.stringify(authData, null, 2);

  console.log(`Writing auth.json to ${agentDir}...`);
  await runAsPi(`mkdir -p ${agentDir} && cat > ${authFilePath} << 'SKYNOT_AUTH_EOF'
${authJson}
SKYNOT_AUTH_EOF
chmod 600 ${authFilePath}`);
  console.log('Auth configuration saved.');
}

async function copySshKeys(): Promise<void> {
  const currentUserHome = os.homedir();
  const sshDir = path.join(currentUserHome, '.ssh');
  const privateKey = path.join(sshDir, 'id_rsa');
  const publicKey = path.join(sshDir, 'id_rsa.pub');

  if (!fs.existsSync(privateKey) || !fs.existsSync(publicKey)) {
    console.error('SSH keys not found at ~/.ssh/id_rsa and ~/.ssh/id_rsa.pub. Skipping SSH setup.');
    return;
  }

  const piHome = getPiHome();
  const piSshDir = path.join(piHome, '.ssh');

  console.log(`Copying SSH keys to ${piSshDir}...`);



  const reason = 'required to copy SSH keys';

  // Create .ssh dir with proper ownership and permissions
  await runAsPi(`mkdir -p ${piSshDir} && chmod 700 ${piSshDir}`);

  // Copy keys as root (pi user can't read the source), then chown to pi
  await askSudoPasswordAndRun(`cp ${privateKey} ${piSshDir}/id_rsa && chown ${AGENT_USER} ${piSshDir}/id_rsa && chmod 600 ${piSshDir}/id_rsa`, reason);
  await askSudoPasswordAndRun(`cp ${publicKey} ${piSshDir}/id_rsa.pub && chown ${AGENT_USER} ${piSshDir}/id_rsa.pub && chmod 644 ${piSshDir}/id_rsa.pub`, reason);

  // Add GitHub's host key to known_hosts to avoid interactive prompt
  await runAsPi(`ssh-keyscan -t rsa github.com >> ${piSshDir}/known_hosts`);
  console.log('SSH keys copied, permissions set, and GitHub added to known_hosts.');
}

async function wipeInstallation(): Promise<void> {
  const installDir = getPiInstallDir();
  if (fs.existsSync(installDir)) {
    console.log(`Wiping existing installation at ${installDir}...`);
    await runAsPi(`rm -rf ${installDir}`);
    console.log('Installation wiped.');
  } else {
    console.log('No existing installation found, nothing to wipe.');
  }
}

async function destroyInstallation(): Promise<void> {
  const piHome = getPiHome();
  const platform = os.platform();

  console.log('\n=== DESTROY MODE ===');
  console.log('This will permanently DELETE:');
  console.log(`  - The '${AGENT_USER}' user`);
  console.log(`  - All data in ${piHome} (the user\'s home directory)`);
  console.log(`  - The '${AGENT_GROUP_NAME}' group`);
  console.log(`  - The launcher script ~/bin/${LAUNCHER_SCRIPT_FILENAME}`);
  console.log('');

  const confirmation = await askQuestion('Are you absolutely sure? Type "DELETE" to confirm: ');
  if (confirmation.trim() !== 'DELETE') {
    console.log('Aborted. Nothing was deleted.');
    return;
  }

  const reason = 'required to destroy installation';

  // Delete the user first (which also removes the home directory on Linux with -r, and on macOS sysadminctl removes the home)
  console.log(`Deleting user '${AGENT_USER}'...`);
  if (await userExists(AGENT_USER)) {
    if (platform === 'darwin') {
      // sysadminctl deletes the user and its home directory by default
      await askSudoPasswordAndRun(`sysadminctl -deleteUser ${AGENT_USER}`, reason);
    } else {
      // -r flag removes the home directory
      await askSudoPasswordAndRun(`userdel -r ${AGENT_USER}`, reason);
    }
    console.log(`User '${AGENT_USER}' deleted.`);
  } else {
    console.log(`User '${AGENT_USER}' does not exist, skipping (already deleted or not created yet).`);
  }

  // Ensure home directory is gone (some macOS configs may leave it)
  if (fs.existsSync(piHome)) {
    console.log(`Cleaning residual home directory ${piHome}...`);
    await askSudoPasswordAndRun(`rm -rf ${piHome}`, reason);
    console.log('Residual home directory removed.');
  }

  // Delete the group
  console.log(`Deleting group '${AGENT_GROUP_NAME}'...`);
  if (await groupExists(AGENT_GROUP_NAME)) {
    if (platform === 'darwin') {
      await askSudoPasswordAndRun(`dscl . -delete /Groups/${AGENT_GROUP_NAME}`, reason);
    } else {
      await askSudoPasswordAndRun(`groupdel ${AGENT_GROUP_NAME}`, reason);
    }
    console.log(`Group '${AGENT_GROUP_NAME}' deleted.`);
  } else {
    console.log(`Group '${AGENT_GROUP_NAME}' does not exist, skipping (already deleted or not created yet).`);
  }

  // Remove the launcher script
  const launcherPath = path.join(os.homedir(), 'bin', LAUNCHER_SCRIPT_FILENAME);
  if (fs.existsSync(launcherPath)) {
    console.log(`Removing launcher script at ${launcherPath}...`);
    fs.unlinkSync(launcherPath);
    console.log('Launcher script removed.');
  }

  console.log('\n=== DESTROY COMPLETE ===');
  console.log('All related resources have been removed.');
}

async function main() {
  if (os.platform() === 'win32') {
    throw new Error('Windows is not supported. Please run skynot on Linux or macOS.');
  }

  const program = new Command();
  program
    .version(pkg.version, '-V, --version', 'Output the version number')
    .description(pkg.description)
    .helpOption('-h, --help', 'Show this help message')
    .option('-v, --verbose', 'Show detailed output from install commands (useful for slow connections or debugging)')
    .option('-u, --update', `Wipe and reinstall Pi, to get the latest version`)
    .option('-e, --extensions', `Install recommended extensions after installing Pi`)
    .option('-a, --auth', `Configure provider authentication (creates auth.json for the '${AGENT_USER}' user)`)
    .option('-s, --ssh', `Copy current user's SSH keys to the '${AGENT_USER}' user for git SSH access (and add GitHub to known_hosts)`)
    .option('-p, --paranoid', `Never cache the sudo password; ask for it every time it is needed`)
    .option('--BURN, --destroy', `Destroy the '${AGENT_USER}' user, their home directory (${getPiHome()}), and the '${AGENT_GROUP_NAME}' group. Requires typing 'DELETE' to confirm.`);
  program.parse(process.argv);
  const opts = program.opts();

  if (opts.paranoid) {
    paranoidMode = true;
  }

  if (opts.destroy) {
    if (opts.update || opts.extensions || opts.auth || opts.ssh) {
      console.error('Error: --destroy is only compatible with --verbose and/or --paranoid flags)');
      console.error('Please try again with a different flags combination.');
      process.exit(1);
    }
    await destroyInstallation();
    return;
  }

  await ensurePiUser();

  if (opts.update) {
    await wipeInstallation();
  }

  await installAgent(opts.verbose);

  if (opts.extensions) {
    await installExtensions(opts.verbose);
  }

  if (opts.auth) {
    await configureAuth();
  }

  if (opts.ssh) {
    await copySshKeys();
  }

  await updatePath();
  await createLauncherScript();

  const workDir = await setupWorkDir();
  console.log(`\nPi is ready to be launched with '${LAUNCHER_SCRIPT_FILENAME}' command.`);
  console.log(`\nRECOMMENDED next steps:`);
  console.log(`1. Log out of the system and log in again (for the group permissions to take effect)`);
  console.log(`2. \`cd\` into '${workDir}'`);
  console.log(`3. Clone the git repository where you will work on`);
  console.log(`4. \`cd\` into the cloned repository`);
  console.log(`5. Launch via \`${LAUNCHER_SCRIPT_FILENAME}\`\n`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
