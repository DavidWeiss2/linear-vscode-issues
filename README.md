[Under-development]

# Linear Git Tools

VS Code extension that creates and opens GIT branches from Linear issues and vice versa.

Once installed, just go to the command menu with:

`Cmd + Shift + P`

And type "Linear Git Tools". You'll see commands like "Linear Git Tools: Create GIT branch", "Linear Git Tools: Create Linear issue", and "Linear Git Tools: Open Linear issue" appear.

This extension uses our VS Code Linear API authentication provider that is exposed by the [linear-connect](https://marketplace.visualstudio.com/items?itemName=Linear.linear-connect) extension. Feel free to use that in your own extensions!

---

## Developing & Contributing

After cloning the repo, use `yarn` to install all the package dependencies.

In VS Code you can change the code and run the extension in a separate app window to test with F5 (Run > Start Debugging).

### Publishing

To publish a new version of the extension, first install the [vsce](https://www.npmjs.com/package/vsce) package, which is used to build VS Code extension packages.

```bash
npm i -g vsce
```

Then make sure to:

1. Update the version in `package.json` according to semver
2. Add appropriate changes to `CHANGELOG.md`

Build the new extension package.

```bash
vsce package
```

This produces a new file `linear-git-tools-1.1.0.vsix`, if your version was set to 1.1.0 in `package.json`.

You can use this file to release a new version of the extension on the [VS Code marketplace](https://marketplace.visualstudio.com/manage/publishers/DavidWeiss2).

