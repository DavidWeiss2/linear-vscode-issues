import { LinearClient } from "@linear/sdk";
import * as cp from "child_process";
import * as vscode from "vscode";
import { window } from "vscode";
/**
 * This extension registers the "Open in Linear command" upon activation.
 */

const LINEAR_AUTHENTICATION_PROVIDER_ID = "linear";
const LINEAR_AUTHENTICATION_SCOPES = ["read"];

const execShell = (cmd: string) =>
  new Promise<string>((resolve, reject) => {
    cp.exec(cmd, (err, out) => {
      if (err) {
        return reject(err);
      }
      return resolve(out);
    });
  });
async function getBranchInput(issueLabel: string) {
  let branch = await window.showInputBox({
    title: "enter branch name:",
    value: `${issueLabel}-`,
  });
  if (branch) {
    branch = branch?.toLowerCase().trim().replace(/\s+/g, "-");
    window.showInformationMessage(`creating branch: ${branch}`);
    let wf = vscode.workspace.workspaceFolders[0].uri.path;
    const branchName = await execShell(`cd ${wf}; git checkout -b ${branch}`);
    window.showInformationMessage(`done!`);
  }
}
export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "linear-create-branch.createBranch",
    async () => {
      const session = await vscode.authentication.getSession(
        LINEAR_AUTHENTICATION_PROVIDER_ID,
        LINEAR_AUTHENTICATION_SCOPES,
        { createIfNone: true }
      );

      if (!session) {
        vscode.window.showErrorMessage(
          `We weren't able to log you into Linear when trying to open the issue.`
        );
        return;
      }

      const linearClient = new LinearClient({
        accessToken: session.accessToken,
      });

      // Use VS Code's built-in Git extension API to get the current branch name.

      try {
        const request: {
          viewer: {
            id: string;
            name: string;
            email: string;
          } | null;
        } | null = await linearClient.client.request(`query Me {
          viewer {
            id
            name
            email
          }
        }`);
        const userId = request?.viewer?.id;
        if (userId) {
          const request2: {
            user: {
              assignedIssues: {
                nodes: {
                  identifier: string;
                  title: string;
                  cycle: {
                    number: number;
                  };
                }[];
              };
              id: string;
              name: string;
            } | null;
          } | null = await linearClient.client.request(`query {
          user(id: "${userId}") {
            id
            name
            assignedIssues {
              nodes {
                title
                identifier
                cycle {
                  number
                }
              }
            }
          }
        }`);

          const issues = request2?.user?.assignedIssues.nodes || [];

          const cycleNumbers = issues.map((i) => i.cycle?.number || 0);

          const maxCycle = Math.max(...cycleNumbers);
          const curIssues =
            issues?.filter((i) => i.cycle?.number === maxCycle || 0) || [];

          const quickPick = window.createQuickPick();
          quickPick.items = curIssues.map((i) => ({
            label: `${i.identifier}: ${i.title}`,
            detail: ``,
          }));
          quickPick.onDidAccept(() => {
            getBranchInput(quickPick.activeItems[0].label.split(":")[0]);
          });
          quickPick.show();
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `An error occurred while trying to fetch Linear issue information. Error: ${error}`
        );
      }
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
