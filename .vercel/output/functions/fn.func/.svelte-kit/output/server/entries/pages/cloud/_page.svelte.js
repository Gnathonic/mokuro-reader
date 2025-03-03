import { c as create_ssr_component, a as compute_rest_props, d as spread, e as escape_object, f as escape_attribute_value, v as validate_component, g as escape } from "../../../chunks/ssr.js";
import "../../../chunks/db.js";
import { p as progressTrackerStore, a as showSnackbar } from "../../../chunks/progress-tracker.js";
import "@zip.js/zip.js";
import { B as Button } from "../../../chunks/misc.js";
import { twMerge } from "tailwind-merge";
const GoogleSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["size", "role", "ariaLabel"]);
  let { size = "md" } = $$props;
  let { role = "img" } = $$props;
  const sizes = {
    xs: "w-3 h-3",
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
    xl: "w-8 h-8"
  };
  let { ariaLabel = "google solid" } = $$props;
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.role === void 0 && $$bindings.role && role !== void 0)
    $$bindings.role(role);
  if ($$props.ariaLabel === void 0 && $$bindings.ariaLabel && ariaLabel !== void 0)
    $$bindings.ariaLabel(ariaLabel);
  return `<svg${spread(
    [
      { xmlns: "http://www.w3.org/2000/svg" },
      { fill: "currentColor" },
      escape_object($$restProps),
      {
        class: escape_attribute_value(twMerge("shrink-0", sizes[size], $$props.class))
      },
      { role: escape_attribute_value(role) },
      {
        "aria-label": escape_attribute_value(ariaLabel)
      },
      { viewBox: "0 0 18 19" }
    ],
    {}
  )}><path fill="currentColor" fill-rule="evenodd" d="M8.842 18.083A8.8 8.8 0 0 1 .193 9.135a8.841 8.841 0 0 1 8.8-8.652h.152a8.464 8.464 0 0 1 5.7 2.257l-2.193 2.038A5.27 5.27 0 0 0 9.091 3.4a5.882 5.882 0 0 0-.2 11.761h.124a5.091 5.091 0 0 0 5.248-4.058L14.3 11H9V8h8.341c.065.543.094 1.09.087 1.636-.086 5.053-3.463 8.449-8.4 8.449l-.186-.002Z" clip-rule="evenodd"></path></svg> `;
});
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const READER_FOLDER = "mokuro-reader";
const VOLUME_DATA_FILE = "volume-data.json";
const PROFILES_FILE = "profiles.json";
const Page = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let { accessToken = "" } = $$props;
  function handleDriveError(error, context) {
    const errorMessage = error.toString().toLowerCase();
    const isConnectivityError = errorMessage.includes("network") || errorMessage.includes("connection") || errorMessage.includes("offline") || errorMessage.includes("internet");
    if (!isConnectivityError) {
      logout();
      showSnackbar(`Error ${context}: ${error.message || "Unknown error"}`);
    } else {
      showSnackbar("Connection error: Please check your internet connection");
    }
    console.error(`${context} error:`, error);
  }
  let readerFolderId = "";
  let volumeDataId = "";
  let profilesId = "";
  async function connectDrive(resp) {
    if (resp?.error !== void 0) {
      localStorage.removeItem("gdrive_token");
      accessToken = "";
      throw resp;
    }
    accessToken = resp?.access_token;
    const processId = "connect-drive";
    progressTrackerStore.addProcess({
      id: processId,
      description: "Connecting to Google Drive",
      progress: 0,
      status: "Initializing connection..."
    });
    try {
      progressTrackerStore.updateProcess(processId, {
        progress: 20,
        status: "Checking for reader folder..."
      });
      const { result: readerFolderRes } = await gapi.client.drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${READER_FOLDER}'`,
        fields: "files(id)"
      });
      if (readerFolderRes.files?.length === 0) {
        progressTrackerStore.updateProcess(processId, {
          progress: 40,
          status: "Creating reader folder..."
        });
        const { result: createReaderFolderRes } = await gapi.client.drive.files.create({
          resource: {
            mimeType: FOLDER_MIME_TYPE,
            name: READER_FOLDER
          },
          fields: "id"
        });
        readerFolderId = createReaderFolderRes.id || "";
      } else {
        const id = readerFolderRes.files?.[0]?.id || "";
        readerFolderId = id || "";
      }
      progressTrackerStore.updateProcess(processId, {
        progress: 60,
        status: "Checking for volume data..."
      });
      const { result: volumeDataRes } = await gapi.client.drive.files.list({
        q: `'${readerFolderId}' in parents and name='${VOLUME_DATA_FILE}'`,
        fields: "files(id, name)"
      });
      if (volumeDataRes.files?.length !== 0) {
        volumeDataId = volumeDataRes.files?.[0].id || "";
      }
      progressTrackerStore.updateProcess(processId, {
        progress: 80,
        status: "Checking for profiles..."
      });
      const { result: profilesRes } = await gapi.client.drive.files.list({
        q: `'${readerFolderId}' in parents and name='${PROFILES_FILE}'`,
        fields: "files(id, name)"
      });
      if (profilesRes.files?.length !== 0) {
        profilesId = profilesRes.files?.[0].id || "";
      }
      progressTrackerStore.updateProcess(processId, {
        progress: 100,
        status: "Connected successfully"
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3e3);
      if (accessToken) {
        showSnackbar("Connected to Google Drive");
      }
    } catch (error) {
      progressTrackerStore.updateProcess(processId, { progress: 0, status: "Connection failed" });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3e3);
      handleDriveError(error, "connecting to Google Drive");
    }
  }
  function logout() {
    localStorage.removeItem("gdrive_token");
    accessToken = "";
    if (gapi.client.getToken()) {
      const token = gapi.client.getToken().access_token;
      gapi.client.setToken(null);
      fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }).catch((error) => {
        console.error("Error revoking token:", error);
      });
    }
  }
  if ($$props.accessToken === void 0 && $$bindings.accessToken && accessToken !== void 0)
    $$bindings.accessToken(accessToken);
  if ($$props.connectDrive === void 0 && $$bindings.connectDrive && connectDrive !== void 0)
    $$bindings.connectDrive(connectDrive);
  if ($$props.logout === void 0 && $$bindings.logout && logout !== void 0)
    $$bindings.logout(logout);
  {
    if (accessToken) {
      localStorage.setItem("gdrive_token", accessToken);
    }
  }
  return `${$$result.head += `<!-- HEAD_svelte-vx7v1c_START -->${$$result.title = `<title>Cloud</title>`, ""}<!-- HEAD_svelte-vx7v1c_END -->`, ""} <div class="p-2 h-[90svh]">${accessToken ? `<div class="flex justify-between items-center gap-6 flex-col"><div class="flex justify-between items-center w-full max-w-3xl"><h2 class="text-3xl font-semibold text-center pt-2" data-svelte-h="svelte-1dpf5jc">Google Drive:</h2> ${validate_component(Button, "Button").$$render($$result, { color: "red" }, {}, {
    default: () => {
      return `Log out`;
    }
  })}</div> <p class="text-center">Add your zipped manga files (ZIP or CBZ) to the <span class="text-primary-700">${escape(READER_FOLDER)}</span> folder
        in your Google Drive.</p> <p class="text-center text-sm text-gray-500" data-svelte-h="svelte-1bj18pj">You can select multiple ZIP/CBZ files or entire folders at once.</p> <div class="flex flex-col gap-4 w-full max-w-3xl">${validate_component(Button, "Button").$$render($$result, { color: "blue" }, {}, {
    default: () => {
      return `Download Manga`;
    }
  })} <div class="flex-col gap-2 flex">${validate_component(Button, "Button").$$render($$result, { color: "dark" }, {}, {
    default: () => {
      return `Upload volume data`;
    }
  })} ${volumeDataId ? `${validate_component(Button, "Button").$$render($$result, { color: "alternative" }, {}, {
    default: () => {
      return `Download volume data`;
    }
  })}` : ``}</div> <div class="flex-col gap-2 flex">${validate_component(Button, "Button").$$render($$result, { color: "dark" }, {}, {
    default: () => {
      return `Upload profiles`;
    }
  })} ${profilesId ? `${validate_component(Button, "Button").$$render($$result, { color: "alternative" }, {}, {
    default: () => {
      return `Download profiles`;
    }
  })}` : ``}</div></div></div>` : `<div class="flex justify-center pt-0 sm:pt-32"><button class="w-full border rounded-lg border-slate-600 p-10 border-opacity-50 hover:bg-slate-800 max-w-3xl"><div class="flex sm:flex-row flex-col gap-2 items-center justify-center">${validate_component(GoogleSolid, "GoogleSolid").$$render($$result, { size: "lg" }, {}, {})} <h2 class="text-lg" data-svelte-h="svelte-1b9un9c">Connect to Google Drive</h2></div></button></div>`}</div>`;
});
export {
  Page as default
};
