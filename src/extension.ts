import { LinearClient } from "@linear/sdk";
import { exec } from "child_process";
import { authentication, commands, env, ExtensionContext, extensions, Uri, window, workspace } from "vscode";
import { GitExtension } from "./types.d/git";
/**
 * This extension registers the "Open in Linear command" upon activation.
 */

const LINEAR_AUTHENTICATION_PROVIDER_ID = "linear";
const LINEAR_AUTHENTICATION_SCOPES = ["read", "issues:create"];
const SPRINT_TIME_QUERY = "-P2W"; // past 2 weeks
const NAMESPACE = "linear-git-tools";

export function activate(context: ExtensionContext) {
  const createBranchCommandDisposable = commands.registerCommand(
    `${NAMESPACE}.createBranch`,
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
          getInputAndCreateBranch(quickPick.activeItems[0].label);
        });

        let timeout: NodeJS.Timeout;
        quickPick.onDidChangeValue(async (value) => {
          clearTimeout(timeout);
          timeout = setTimeout(async () => {
            if (value) {
              const searchIssues = await fetchIssuesWithSearch(
                linearClient,
                value
              );
              if (searchIssues.length === 0) {
                return;
              }
              quickPick.items = searchIssues.concat(issues).map((i) => ({
                label: `${i.identifier}: ${i.title}`,
                detail: ``,
              }));
            }
          }, 500);
        });

        quickPick.onDidChangeValue((value) => {
          if (value?.match(/^\w*\-?\d/) && quickPick.activeItems.length === 0) {
            quickPick.items = [
              {
                label: `Create branch: ${value}`,
                detail: "",
              }
            ].concat(issues.map((i) => ({
              label: `${i.identifier}: ${i.title}`,
              detail: i.cycle?.number ? `Sprint ${i.cycle.number}` : "",
            })));
          }
        });

        quickPick.show();
      } catch (error) {
        window.showErrorMessage(
          `An error occurred while trying to fetch Linear issue information. Error: ${error}`
        );
      }
    }
  );

  context.subscriptions.push(createBranchCommandDisposable);

  const createLinearIssueCommandDisposable = commands.registerCommand(
    `${NAMESPACE}.createIssue`,
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
          const title = await window.showInputBox({
            placeHolder: "Issue title",
            prompt: "",
            value: "",
          });
          if (!title) {
            window.showErrorMessage(`No title found`);
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
            window.showErrorMessage(`Issue not created`);
            return;
          }
          window
            .showInformationMessage(`Issue created successfully ${issue.identifier}`, "Open Issue")
            .then(() => {
              env.openExternal(Uri.parse(url));
            }).then(() => {
              const autoCheckoutBranchAfterIssueCreation: "ask" | "yes" | "no" = workspace.getConfiguration().get("linear-git-tools.autoCheckoutBranchAfterIssueCreation", "ask");
              if (autoCheckoutBranchAfterIssueCreation === "ask") {
                window.showInformationMessage("Do you want to create a branch for this issue?", "Yes", "No").then((value) => {
                  if (value === "Yes") {
                    getInputAndCreateBranch(`${issue.identifier}: ${issue.title}`);
                  }
                });
              } else if (autoCheckoutBranchAfterIssueCreation === "yes") {
                getInputAndCreateBranch(`${issue.identifier}: ${issue.title}`);
              }
            });
        });

        quickPick.show();
      } catch (error) {
        window.showErrorMessage(
          `An error occurred while trying to create linear issue. Error: ${error}`
        );
      }
    }
  );
  context.subscriptions.push(createLinearIssueCommandDisposable);

  const openLinearIssueCommandDisposable = commands.registerCommand(
    `${NAMESPACE}.openIssue`,
    async () => {
      const linearClient = await getLinearClient();

      // Use VS Code's built-in Git extension API to get the current branch name.
      const gitExtension =
        extensions.getExtension<GitExtension>("git")?.exports;
      const git = gitExtension?.getAPI(1);
      const branchName = git?.repositories[0]?.state.HEAD?.name;

      try {
        const request: {
          issueVcsBranchSearch: {
            identifier: string;
            team: {
              organization: {
                urlKey: string;
              };
            };
          } | null;
        } | null = await linearClient.client.request(`query {
            issueVcsBranchSearch(branchName: "${branchName}") {
              identifier
              team {
                organization {
                  urlKey
                }
              }
            }
          }`);

        if (request?.issueVcsBranchSearch?.identifier) {
          // Preference to open the issue in the desktop app or in the browser.
          const urlPrefix = workspace
            .getConfiguration()
            .get<boolean>("linear-git-tools.openInDesktopApp")
            ? "linear://"
            : "https://linear.app/";

          // Open the URL.
          env.openExternal(
            Uri.parse(
              urlPrefix +
              request?.issueVcsBranchSearch.team.organization.urlKey +
              "/issue/" +
              request?.issueVcsBranchSearch.identifier
            )
          );
        } else {
          window.showInformationMessage(
            `No Linear issue could be found matching the branch name ${branchName} in the authenticated workspace.`
          );
        }
      } catch (error) {
        window.showErrorMessage(
          `An error occurred while trying to fetch Linear issue information. Error: ${error}`
        );
      }
    }
  );

  context.subscriptions.push(openLinearIssueCommandDisposable);

  const updateLinearIssueStatusCommandDisposable =
    commands.registerCommand(`${NAMESPACE}.updateIssue`, async () => {
      const linearClient = await getLinearClient();

      // Use VS Code's built-in Git extension API to get the current branch name.
      const gitExtension =
        extensions.getExtension<GitExtension>("git")?.exports;
      const git = gitExtension?.getAPI(1);
      const branchName = git?.repositories[0]?.state.HEAD?.name;

      try {
        const request: {
          issueVcsBranchSearch: {
            identifier: string;
            team: {
              organization: {
                urlKey: string;
              };
            };
          } | null;
        } | null = await linearClient.client.request(`query {
            issueVcsBranchSearch(branchName: "${branchName}") {
              identifier
              team {
                organization {
                  urlKey
                }
              }
            }
          }`);

        const issueId = request?.issueVcsBranchSearch?.identifier;
        if (!issueId) {
          window.showErrorMessage(
            `No issue found for the current branch`
          );
          return;
        }
        const issue = await linearClient.issue(issueId);
        const updatableFieldsNames = [
          "priority",
          "title",
          "description",
        ] satisfies (keyof Parameters<(typeof issue)["update"]>[0])[];
        const availableCommands: {
          title: string;
          inputMessage: string;
          placeholder: string;
          successMessage: string;
          callback: (userInput: string) => void;
          errorMessage: string;
        }[] = updatableFieldsNames.map((fieldName) => {
          return {
            title: `Update ${fieldName}`,
            inputMessage: issue[fieldName] as string,
            successMessage: `Issue ${fieldName} updated successfully`,
            callback: async (userInput: string) => {
              await issue.update({
                [fieldName]: userInput,
              });
            },
            placeholder: issue[fieldName] as string,
            errorMessage: `An error occurred while trying to update ${fieldName}`,
          };
        });

        const quickPick = window.createQuickPick<{
          label: string;
          detail: string;
          index: number;
        }>();
        quickPick.items = availableCommands.map((command, index) => ({
          label: `${command.title} - ${command.placeholder}`,
          detail: "",
          index,
        }));

        quickPick.onDidAccept(async () => {
          const { index } = quickPick.activeItems[0];
          const { callback, errorMessage, successMessage, inputMessage } =
            availableCommands[index];
          const userInput = await window.showInputBox({
            placeHolder: inputMessage ?? "Enter status",
            prompt: "",
            value: "",
          });
          try {
            if (!userInput) {
              window.showInformationMessage(
                "No input provided, cancelling"
              );
              return;
            }
            callback(userInput);
            window.showInformationMessage(successMessage);
          } catch (error) {
            window.showErrorMessage(errorMessage);
          }
        });

        quickPick.show();
      } catch (error) {
        window.showErrorMessage(
          `An error occurred while trying to fetch Linear issue information. Error: ${error}`
        );
      }
    });

  context.subscriptions.push(updateLinearIssueStatusCommandDisposable);
}

async function getLinearClient() {
  const session = await authentication.getSession(
    LINEAR_AUTHENTICATION_PROVIDER_ID,
    LINEAR_AUTHENTICATION_SCOPES,
    { createIfNone: true }
  );

  if (!session) {
    throw new Error(
      "We weren't able to log you into Linear when trying to open the issue."
    );
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
  const queryString = `query {
      issues(filter: { title: { containsIgnoreCase: "${query}" }}) {
            nodes {
              title
              identifier
              cycle {
                startsAt
              }
            }
          }
        }`;
  return (
    (await linearClient.client.request(queryString)) as {
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

export function deactivate() { }

const execShell = (cmd: string) =>
  new Promise<string>((resolve, reject) => {
    exec(cmd, (err, out) => {
      if (err) {
        return reject(err);
      }
      return resolve(out);
    });
  });
async function getInputAndCreateBranch(issueLabel: string) {
  const includeIssueName = workspace
    .getConfiguration()
    .get<boolean>("linear-git-tools.includeIssueNameInBranch", true);
  const maxCharactersFromIssueName = workspace.getConfiguration().get<number>("linear-git-tools.maxCharactersFromIssueName", 35);

  const chosenIssue = issueLabel;
  const issueLabelId = chosenIssue.split(":")[0];
  const issueName = includeIssueName ? chosenIssue.slice(0, maxCharactersFromIssueName) : issueLabelId;

  let branch = await window.showInputBox({
    title: "enter branch name:",
    value: `${issueName}`.replace(/\s+/g, "-").toLowerCase().replace(/[^a-z0-9 ]+/g, ""),
  });

  if (branch) {
    branch = branch?.toLowerCase().trim().replace(/\s+/g, "-").toLowerCase().replace(/[^a-z0-9 ]+/g, "");
    window.showInformationMessage(`creating branch: ${branch}`);
    let wf = workspace.workspaceFolders?.[0].uri.path;
    if (!wf) {
      window.showErrorMessage(`No workspace folder found`);
      return;
    }
    const branchName = await execShell(`cd ${wf}; git checkout -b ${branch}`);
    window.showInformationMessage(`done!`, branchName);
  }
}
