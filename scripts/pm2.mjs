/* 🍞 AI Breadcrumb: @COUPLED scripts/lifecycle/pm2-manager.mjs, docs/PM2-PRODUCTION.md
 * @CONTRACT Import is inert; only explicit lifecycle actions invoke the supervisor.
 */
import { isMain } from "./lib.mjs";
import { pm2Action } from "./lifecycle/pm2-manager.mjs";

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Provide exactly one PM2 manager action; use --help for usage.");
    if (["--help", "-h"].includes(process.argv[2])) {
      console.log("Usage: npm run pm2 -- install|status|start|stop|restart\n" +
        "PI_DEV_DEPLOY_ROOT defaults to $HOME/.local/share/pi-dev/deploy.\n" +
        "PI_DEV_CONFIG_DIR defaults to $HOME/.config/pi-dev (existing directory).\n" +
        "Install stages the user unit only; start and boot enablement are explicit.\n" +
        "Status prints sanitized metrics and linked build metadata; logs are not exposed.");
    } else pm2Action(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
