import { LinearClient, Team, ViewerQuery } from "@linear/sdk";
import * as cp from "child_process";
import * as vscode from "vscode";
import { window } from "vscode";
/**
 * This extension registers the "Open in Linear command" upon activation.
 */

const LINEAR_AUTHENTICATION_PROVIDER_ID = "linear";
const LINEAR_AUTHENTICATION_SCOPES = ["read", "issues:create"];
const SPRINT_TIME_QUERY = "-P2W"; // past 2 weeks

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
            assignedIssues (filter: {cycle : {startsAt: {gt: "${SPRINT_TIME_QUERY}"} }}) {
              nodes {
                title
                identifier
                cycle {
                  startsAt
                }
              }
            }
          }
        }`);

          const issues = request2?.user?.assignedIssues.nodes || [];

          const quickPick = window.createQuickPick();
          quickPick.items = issues.map((i) => ({
            label: `${i.identifier}: ${i.title}`,
            detail: ``,
          }));
          quickPick.onDidAccept(() => {
            getInputAndCreateBranch(
              quickPick.activeItems[0].label.split(":")[0]
            );
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

  const disposable2 = vscode.commands.registerCommand(
    "linear-create-branch.createIssue",
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
        const me = await linearClient.viewer;

        const teams = await me.teams();
        const quickPick = window.createQuickPick();
        quickPick.items = teams.nodes.map((team) => ({
          label: team.name,
          detail: team.key,
          team,
        }));
        quickPick.onDidAccept(async () => {
          const title = await vscode.window.showInputBox({
            placeHolder: "Issue title",
            prompt: "",
            value: "",
          });

          if (title) {
            const team = quickPick.activeItems[0].team as Team;
            const states = await team.states();
            const state_nodes = await states.nodes
            const inprog = state_nodes.filter(s=>s.type==='started')
            const issue = await linearClient.createIssue({
              teamId: team.id,
              title,
              assigneeId: me.id,
              stateId: inprog[0].id,
            });
            const i = await issue.issue;
            const url = await i?.url;
            if (url) {
              vscode.env.openExternal(vscode.Uri.parse(url));
              vscode.window
                .showInformationMessage(
                  `Issue created successfully`,
                  "Open Issue"
                )
                .then(() => {
                  vscode.env.openExternal(vscode.Uri.parse(url));
                });
            }
          }
        });
        quickPick.show();
      } catch (error) {
        vscode.window.showErrorMessage(
          `An error occurred while trying to create linear issue. Error: ${error}`
        );
      }
    }
  );
  context.subscriptions.push(disposable2);
}

export function deactivate() {}

function daysSince(dateStr: string) {
  const now = new Date();
  const date = new Date(dateStr);
  const msSince: number = now.getTime() - date.getTime();
  return msSince / 60 / 60 / 24 / 1000;
}
const execShell = (cmd: string) =>
  new Promise<string>((resolve, reject) => {
    cp.exec(cmd, (err, out) => {
      if (err) {
        return reject(err);
      }
      return resolve(out);
    });
  });
async function getInputAndCreateBranch(issueLabel: string) {
  const issueLabelFmt = issueLabel.toLowerCase();
  let branch = await window.showInputBox({
    title: "enter branch name:",
    value: `${issueLabelFmt}-`,
  });
  if (branch) {
    branch = branch?.toLowerCase().trim().replace(/\s+/g, "-");
    window.showInformationMessage(`creating branch: ${branch}`);
    let wf = vscode.workspace.workspaceFolders[0].uri.path;
    const branchName = await execShell(`cd ${wf}; git checkout -b ${branch} master`);
    window.showInformationMessage(`done!`);
  }
}
