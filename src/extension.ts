import { LinearClient, ViewerQuery } from "@linear/sdk";
import * as cp from "child_process";
import { get } from "http";
import * as vscode from "vscode";
import { window } from "vscode";
/**
 * This extension registers the "Open in Linear command" upon activation.
 */

const LINEAR_AUTHENTICATION_PROVIDER_ID = "linear";
const LINEAR_AUTHENTICATION_SCOPES = ["read", "issues:create"];
const SPRINT_TIME_QUERY = "-P2W"; // past 2 weeks

export function activate(context: vscode.ExtensionContext) {
  const createBranchCommandDisposable = vscode.commands.registerCommand(
    "linear-create-branch.createBranch",
    async () => {
      try {
        const linearClient = await getLinearClient();
        const userId = await fetchUserId(linearClient);

        if (!userId) {
          window.showErrorMessage(`No user found`);
          return;
        }

        const issues =
          (await fetchUserAssignedIssues(linearClient, userId)) ?? [];

        const quickPick = window.createQuickPick();
        quickPick.items = issues.map((i) => ({
          label: `${i.identifier}: ${i.title}`,
          detail: i.cycle?.number ? `Sprint ${i.cycle.number}` : "",
        }));

        quickPick.onDidAccept(() => {
          getInputAndCreateBranch(quickPick.activeItems[0].label.split(":")[0]);
        });

        quickPick.onDidChangeValue(async (value) => {
          if (value) {
            const issues = await fetchIssuesWithSearch(linearClient, value);
            quickPick.items = issues.map((i) => ({
              label: `${i.identifier}: ${i.title}`,
              detail: ``,
              value: i.identifier,
            }));
          }
        });

        quickPick.show();
      } catch (error) {
        vscode.window.showErrorMessage(
          `An error occurred while trying to fetch Linear issue information. Error: ${error}`
        );
      }
    }
  );

  context.subscriptions.push(createBranchCommandDisposable);

  const createLinearIssueCommandDisposable = vscode.commands.registerCommand(
    "linear-create-branch.createIssue",
    async () => {
      try {
        const linearClient = await getLinearClient();
        
        const me = await linearClient.viewer;

        const teams = await me.teams();

        const quickPick = window.createQuickPick<{
          label: string;
          detail: string;
          value: string;
        }>();
        quickPick.items = teams.nodes.map((team) => ({
          label: team.name,
          detail: team.key,
          value: team.id,
        }));
        quickPick.onDidAccept(async () => {
          const title = await vscode.window.showInputBox({
            placeHolder: "Issue title",
            prompt: "",
            value: "",
          });
          if (!title) {
            vscode.window.showErrorMessage(`No title found`);
            return;
          }
          const issue = await linearClient
            .createIssue({
              teamId: quickPick.activeItems[0].value,
              title,
            })
            .then((issue) => (issue.success ? issue.issue : undefined))
            .catch(() => undefined);

          const url = issue?.url;
          if (!url) {
            vscode.window.showErrorMessage(`Issue not created`);
            return;
          }
          vscode.window
            .showInformationMessage(`Issue created successfully`, "Open Issue")
            .then(() => {
              vscode.env.openExternal(vscode.Uri.parse(url));
            });

          
        });

        quickPick.show();
      } catch (error) {
        vscode.window.showErrorMessage(
          `An error occurred while trying to create linear issue. Error: ${error}`
        );
      }
    }
  );
  context.subscriptions.push(createLinearIssueCommandDisposable);

  const openLinearIssueCommandDisposable = vscode.commands.registerCommand(
    "linear-create-branch.openIssue",
    async () => {
      async () => {
        try {
          const currentBranch = await execShell("git rev-parse --abbrev-ref HEAD");
          if (!currentBranch) {
            window.showErrorMessage(`No branch found`);
            return;
          }
          const isLinearBranch = currentBranch.match(/^(feature|bug|chore|hotfix|)\/(lnr|dit)-\d+/gi);
          if (!isLinearBranch) {
            window.showErrorMessage(`Not a linear branch`);
            return;
          }
          const linearIssueId = currentBranch.split("-")[1];
          const linearClient = await getLinearClient();
          const issue = await linearClient.issue(linearIssueId);
          const url = issue?.url;
          if (!url) {
            vscode.window.showErrorMessage(`Issue not found`);
            return;
          }
          vscode.window
            .showInformationMessage(`Issue found`, "Open Issue")
            .then(() => {
              vscode.env.openExternal(vscode.Uri.parse(url));
            });
        } catch (error) {
          vscode.window.showErrorMessage(
            `An error occurred while trying to fetch Linear issue information. Error: ${error}`
          );
        }
      }
    });

  context.subscriptions.push(openLinearIssueCommandDisposable);
}

async function getLinearClient(){
  const session = await vscode.authentication.getSession(
    LINEAR_AUTHENTICATION_PROVIDER_ID,
    LINEAR_AUTHENTICATION_SCOPES,
    { createIfNone: true }
  );

  if (!session) {
    throw new Error("We weren't able to log you into Linear when trying to open the issue.");
  }

  const linearClient = new LinearClient({
    accessToken: session.accessToken,
  });

  return linearClient;
}

async function fetchUserId(linearClient: LinearClient) {
  return (
    (await linearClient.client.request(`query {
          viewer {
            id
          }
        }`)) as {
      viewer: {
        id: string;
      } | null;
    } | null
  )?.viewer?.id;
}

async function fetchUserAssignedIssues(
  linearClient: LinearClient,
  userId: string
) {
  return (
    (await linearClient.client.request(`query {
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
        }`)) as {
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
    } | null
  )?.user?.assignedIssues.nodes;
}

async function fetchIssuesWithSearch(
  linearClient: LinearClient,
  query: string
) {
  return (
    (await linearClient.client.request(`query {
          issues(search: "${query}") {
            nodes {
              title
              identifier
              cycle {
                startsAt
              }
            }
          }
        }`)) as {
      issues: {
        nodes: {
          identifier: string;
          title: string;
          cycle: {
            number: number;
          };
        }[];
      };
    }
  ).issues.nodes;
}

export function deactivate() {}

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
    let wf = vscode.workspace.workspaceFolders?.[0].uri.path;
    if (!wf) {
      window.showErrorMessage(`No workspace folder found`);
      return;
    }
    const branchName = await execShell(`cd ${wf}; git checkout -b ${branch}`);
    window.showInformationMessage(`done!`,branchName);
  }
}
