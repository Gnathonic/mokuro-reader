import { c as create_ssr_component, a as compute_rest_props, d as spread, e as escape_object, f as escape_attribute_value, k as subscribe, v as validate_component, b as add_attribute, g as escape, l as each } from "../../../chunks/ssr.js";
import { p as progress, c as catalog, b as mangaStats, B as Button } from "../../../chunks/misc.js";
import { p as page } from "../../../chunks/stores.js";
import "../../../chunks/db.js";
import "@zip.js/zip.js";
import { F as Frame, L as ListgroupItem, a as Listgroup } from "../../../chunks/Listgroup.js";
import { twMerge } from "tailwind-merge";
import { T as TrashBinSolid } from "../../../chunks/TrashBinSolid.js";
const CheckCircleSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "check circle solid" } = $$props;
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
      { viewBox: "0 0 20 20" }
    ],
    {}
  )}><path fill="currentColor" d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5Zm3.707 8.207-4 4a1 1 0 0 1-1.414 0l-2-2a1 1 0 0 1 1.414-1.414L9 10.586l3.293-3.293a1 1 0 0 1 1.414 1.414Z"></path></svg> `;
});
const VolumeItem = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let currentPage;
  let progressDisplay;
  let isComplete;
  let $page, $$unsubscribe_page;
  let $progress, $$unsubscribe_progress;
  $$unsubscribe_page = subscribe(page, (value) => $page = value);
  $$unsubscribe_progress = subscribe(progress, (value) => $progress = value);
  let { volume } = $$props;
  const volName = decodeURI(volume.volume_title);
  if ($$props.volume === void 0 && $$bindings.volume && volume !== void 0)
    $$bindings.volume(volume);
  volume.volume_uuid;
  currentPage = $progress?.[volume.volume_uuid || 0] || 1;
  progressDisplay = `${currentPage === volume.page_count - 1 ? currentPage + 1 : currentPage} / ${volume.page_count}`;
  isComplete = currentPage === volume.page_count || currentPage === volume.page_count - 1;
  $$unsubscribe_page();
  $$unsubscribe_progress();
  return `${$page.params.manga ? `${validate_component(Frame, "Frame").$$render(
    $$result,
    {
      rounded: true,
      border: true,
      class: "divide-y divide-gray-200 dark:divide-gray-600"
    },
    {},
    {
      default: () => {
        return `${validate_component(ListgroupItem, "ListgroupItem").$$render($$result, { normalClass: "py-4" }, {}, {
          default: () => {
            return `${volume.thumbnail ? `<img${add_attribute("src", URL.createObjectURL(volume.thumbnail), 0)} alt="img" style="margin-right:10px;" class="object-contain w-[50px] h-[70px] bg-black border-gray-900 border">` : ``} <div class="${[
              "flex flex-row gap-5 items-center justify-between w-full",
              isComplete ? "text-green-400" : ""
            ].join(" ").trim()}"><div><p class="${["font-semibold", !isComplete ? "text-white" : ""].join(" ").trim()}">${escape(volName)}</p> <p>${escape(progressDisplay)}</p></div> <div class="flex gap-2">${validate_component(TrashBinSolid, "TrashBinSolid").$$render(
              $$result,
              {
                class: "text-red-400 hover:text-red-500 z-10 poin"
              },
              {},
              {}
            )} ${isComplete ? `${validate_component(CheckCircleSolid, "CheckCircleSolid").$$render($$result, {}, {}, {})}` : ``}</div></div>`;
          }
        })}`;
      }
    }
  )}` : ``}`;
});
function sortManga(a, b) {
  return a.volume_title.localeCompare(b.volume_title, void 0, { numeric: true, sensitivity: "base" });
}
const Page = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let manga;
  let loading;
  let $page, $$unsubscribe_page;
  let $catalog, $$unsubscribe_catalog;
  let $mangaStats, $$unsubscribe_mangaStats;
  $$unsubscribe_page = subscribe(page, (value) => $page = value);
  $$unsubscribe_catalog = subscribe(catalog, (value) => $catalog = value);
  $$unsubscribe_mangaStats = subscribe(mangaStats, (value) => $mangaStats = value);
  manga = $catalog?.find((item) => item.series_uuid === $page.params.manga)?.volumes.sort(sortManga);
  loading = false;
  $$unsubscribe_page();
  $$unsubscribe_catalog();
  $$unsubscribe_mangaStats();
  return `${$$result.head += `<!-- HEAD_svelte-1w4e7x6_START -->${$$result.title = `<title>${escape(manga?.[0].series_title || "Manga")}</title>`, ""}<!-- HEAD_svelte-1w4e7x6_END -->`, ""} ${manga && $mangaStats ? `<div class="p-2 flex flex-col gap-5"><div class="flex flex-row justify-between"><div class="flex flex-col gap-2"><h3 class="font-bold">${escape(manga[0].series_title)}</h3> <div class="flex flex-col gap-0 sm:flex-row sm:gap-5"><p>Volumes: ${escape($mangaStats.completed)} / ${escape(manga.length)}</p> <p>Characters read: ${escape($mangaStats.chars)}</p> <p>Minutes read: ${escape($mangaStats.timeReadInMinutes)}</p></div></div> <div class="sm:block flex-col flex gap-2">${validate_component(Button, "Button").$$render($$result, { color: "alternative" }, {}, {
    default: () => {
      return `Remove manga`;
    }
  })} ${validate_component(Button, "Button").$$render($$result, { color: "light", disabled: loading }, {}, {
    default: () => {
      return `${escape(loading ? "Extracting..." : "Extract manga")}`;
    }
  })}</div></div> ${validate_component(Listgroup, "Listgroup").$$render(
    $$result,
    {
      active: true,
      class: "flex-1 h-full w-full"
    },
    {},
    {
      default: () => {
        return `${each(manga, (volume) => {
          return `${validate_component(VolumeItem, "VolumeItem").$$render($$result, { volume }, {}, {})}`;
        })}`;
      }
    }
  )}</div>` : `<div class="flex justify-center p-16" data-svelte-h="svelte-5xe0i3">Manga not found</div>`}`;
});
export {
  Page as default
};
