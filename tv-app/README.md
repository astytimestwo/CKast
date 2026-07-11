# CKast TV App

Open this folder in VS Code when using the Samsung Tizen TV extension.

## Build And Install

1. Run `Tizen TV: Set Target Device Address`.
2. Run `Tizen TV: Build Signed Package`.
3. Run `Tizen TV: Launch Application` and choose `Run On TV`.
4. On the TV standby screen, enter the PC IPv4 address in **PC address** and press **Connect**.

The entered PC address is saved on the TV. If the PC IP changes later, edit it on the TV screen; you do not need to rebuild the app.

The PC broadcaster is outside this folder at `../pc-broadcaster/` and must be started separately.
