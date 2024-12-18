import { LinearClient, LinearDocument } from "@linear/sdk";
import { exec } from "child_process";
import {
  authentication,
  commands,
  env,
  ExtensionContext,
  extensions,
  QuickPickItem as VSCodeQuickPickItem,
  QuickPickItemKind,
  ThemeIcon,
  Uri,
  window,
  workspace,
} from "vscode";
import { GitExtension } from "./types.d/git";

type Issue = Pick<
  Awaited<ReturnType<LinearClient["issue"]>>,
  "identifier" | "title" | "branchName" | "state"
>;

interface QuickPickItem extends VSCodeQuickPickItem {
  issue?: Issue;
}

type IssueState =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

const LINEAR_AUTHENTICATION_PROVIDER_ID = "linear";
const LINEAR_AUTHENTICATION_SCOPES = ["read", "issues:create"];
const NAMESPACE = "linear-git-tools";

const isMe = { isMe: { eq: true } };
const True = { eq: true };
const False = { neq: true };
const MINIMUM_ITEMS_ACTIVE_BEFORE_SEARCH = 5;

export function activate(context: ExtensionContext) {
  const createBranchCommandDisposable = commands.registerCommand(
    `${NAMESPACE}.createBranch`,
    async () => {
      try {
        const quickPick = window.createQuickPick<QuickPickItem>();

        quickPick.title = "Select an issue to create a branch for";
        quickPick.placeholder = "Search for an issue to create a branch for";
        quickPick.items = [
          { label: "Loading...", alwaysShow: true } as QuickPickItem,
        ];
        quickPick.busy = true;
        quickPick.show();

        const actions: {
          tooltip: string;
          action: () => void;
          iconId: string;
        }[] = [
          {
            tooltip: "Create new issue",
            action: () => commands.executeCommand(`${NAMESPACE}.createIssue`),
            iconId: "add",
          },
        ];
        const actionsItems = actions.map(
          ({ iconId, tooltip }) =>
            ({
              iconPath: new ThemeIcon(iconId),
              label: tooltip,
              kind: QuickPickItemKind.Default,
              alwaysShow: true,
            } satisfies QuickPickItem)
        );

        const separatorItem = {
          label: "actions",
          kind: QuickPickItemKind.Separator,
        } satisfies QuickPickItem;

        const linearClient = await getLinearClient();

        const issueConnection = (await fetchUserIssues(linearClient)) ?? [];
        const issues: Issue[] = issueConnection.nodes ?? []; // todo: handle pagination
        const issueItems = await Promise.all(issues.map(toIssueItem));

        const items = [
          ...actionsItems,
          separatorItem,
          ...issueItems,
        ] as const satisfies QuickPickItem[];

        quickPick.items = items;

        quickPick.onDidAccept(async (selected) => {
          const item = quickPick.activeItems[0];
          if (!item.issue) {
            const action = actions.find((a) => a.tooltip === item.label);
            if (action) {
              return action.action();
            }
            return;
          }
          return createBranch(item.issue.branchName);
        });

        let timeout: NodeJS.Timeout;
        quickPick.onDidChangeValue(async (value) => {
          clearTimeout(timeout);
          timeout = setTimeout(async () => {
            if (
              value &&
              quickPick.activeItems.length < MINIMUM_ITEMS_ACTIVE_BEFORE_SEARCH
            ) {
              quickPick.busy = true;
              const searchIssues = await fetchIssuesWithSearch(
                linearClient,
                value
              ).then((res) => res.nodes);

              quickPick.items = items.concat(
                await Promise.all(searchIssues.map(toIssueItem))
              );
              quickPick.busy = false;
            }
          }, 500);
        });
        quickPick.busy = false;
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
        const quickPick = window.createQuickPick<
          QuickPickItem & { value?: string }
        >();
        quickPick.title = "Select a team to create an issue for";
        quickPick.placeholder = "Select a team";
        quickPick.items = [
          { label: "Loading...", alwaysShow: true } as QuickPickItem,
        ];
        quickPick.busy = true;
        quickPick.show();

        const linearClient = await getLinearClient();

        const me = await linearClient.viewer;

        const teams = await me.teams();

        quickPick.items = teams.nodes.map((team) => ({
          label: team.name,
          detail: team.key,
          value: team.id,
        }));

        quickPick.onDidAccept(async () => {
          const teamId = quickPick.activeItems[0].value;
          if (!teamId) {
            window.showErrorMessage(`No team found`);
            return;
          }
          const title = await window.showInputBox({
            placeHolder: "Issue title",
            prompt: "",
            value: "",
          });
          if (!title) {
            window.showErrorMessage(`No title found`);
            return;
          }
          quickPick.busy = true;
          const issue = await linearClient
            .createIssue({
              teamId,
              title,
            })
            .then((issue) => (issue.success ? issue.issue : undefined))
            .catch(() => undefined);

          const url = issue?.url;
          if (!url) {
            window.showErrorMessage(`Issue not created`);
            return;
          }
          quickPick.busy = false;
          window
            .showInformationMessage(
              `Issue created successfully ${issue.identifier}`,
              "Open Issue"
            )
            .then(() => {
              env.openExternal(Uri.parse(url));
            })
            .then(() => {
              const autoCheckoutBranchAfterIssueCreation: "ask" | "yes" | "no" =
                workspace
                  .getConfiguration()
                  .get(
                    "linear-git-tools.autoCheckoutBranchAfterIssueCreation",
                    "ask"
                  );
              if (autoCheckoutBranchAfterIssueCreation === "ask") {
                return window
                  .showInformationMessage(
                    "Do you want to create a branch for this issue?",
                    "Yes",
                    "No"
                  )
                  .then((value) => {
                    if (value === "Yes") {
                      return createBranch(issue.branchName);
                    }
                  });
              } else if (autoCheckoutBranchAfterIssueCreation === "yes") {
                return createBranch(issue.branchName);
              }
            });
        });

        quickPick.busy = false;
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

      try {
        const issue = await getCurrentBranchIssue(linearClient);

        // Preference to open the issue in the desktop app or in the browser.
        const openInDesktop = workspace
          .getConfiguration()
          .get<boolean>("linear-git-tools.openInDesktopApp");

        const url = openInDesktop
          ? issue.url.replace("https://linear.app/", "linear://")
          : issue.url;

        // Open the URL.
        env.openExternal(Uri.parse(url));
      } catch (error) {
        window.showErrorMessage(
          `An error occurred while trying to fetch Linear issue information. Error: ${error}`
        );
      }
    }
  );

  context.subscriptions.push(openLinearIssueCommandDisposable);

  const updateLinearIssueStatusCommandDisposable = commands.registerCommand(
    `${NAMESPACE}.updateIssue`,
    async () => {
      const linearClient = await getLinearClient();


      try {
        const issue =await getCurrentBranchIssue(linearClient);
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
              window.showInformationMessage("No input provided, cancelling");
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
    }
  );

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

function stateIsNot(...state: IssueState[]) {
  return { type: { nin: state } };
}

async function fetchUserIssues(linearClient: LinearClient) {
  return await linearClient.issues({
    filter: {
      cycle: {
        or: [{ isNext: True }, { isPrevious: True }, { isActive: True },{ null: true }],
      },
      state: stateIsNot("canceled", "completed"),
      or: [
        {
          assignee: {or:[isMe, { null:true }] },
        },
        {
          creator: isMe,
        },
        {
          subscribers: isMe,
        },
      ],
    },
    orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
  });
}

async function fetchIssuesWithSearch(
  linearClient: LinearClient,
  query: string
) {
  const issueSearch = await linearClient.searchIssues(query, {
    includeArchived: false,
    orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
    includeComments: true,
  });
  return issueSearch;
}

async function getCurrentBranchIssue(linearClient: LinearClient) {
  const gitExtension = extensions.getExtension<GitExtension>("git")?.exports;
  const git = gitExtension?.getAPI(1);
  const branchName = git?.repositories[0]?.state.HEAD?.name;

  if (!branchName) {
    throw new Error("No branch found");
  }

  const issue = await linearClient.issueVcsBranchSearch(branchName);
  if(!issue){
    throw new Error("No issue found for the current branch");
  }
  return issue;
}

async function toIssueItem(issue: Issue): Promise<QuickPickItem> {
  const awaitedState = await issue.state;
  const state = awaitedState ? ` (${awaitedState.name}) ` : "";
  const branchName = issue.branchName ? `Branch: ${issue.branchName}` : "";

  return {
    label: `${state}${issue.identifier} - ${issue.title}`,
    detail:branchName,
    issue,
  };
}

export function deactivate() {}

const execShell = (cmd: string) =>
  new Promise<string>((resolve, reject) => {
    exec(cmd, (err, out) => {
      if (err) {
        return reject(err);
      }
      return resolve(out);
    });
  });

async function createBranch(branchName: string | undefined) {
  if (branchName) {
    window.showInformationMessage(`creating branch: ${branchName}`);
    let wf = workspace.workspaceFolders?.[0].uri.path;
    if (!wf) {
      window.showErrorMessage(`No workspace folder found`);
      return;
    }
    const result = await execShell(
      `cd ${wf}; git switch ${branchName} 2>/dev/null || git checkout -B ${branchName}`
    );
    window.showInformationMessage(`done!`, result);
  }
}
