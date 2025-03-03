import { c as create_ssr_component, a as compute_rest_props, v as validate_component, b as add_attribute, i as compute_slots, d as spread, e as escape_object, f as escape_attribute_value, k as subscribe, g as escape, l as each } from "../../chunks/ssr.js";
import { v as volumes, p as progress, m as miscSettings, a as volumes$1, c as catalog, B as Button } from "../../chunks/misc.js";
import { i as isUpgrading } from "../../chunks/db.js";
import { W as Wrapper, I as Input } from "../../chunks/Input.js";
import { L as ListgroupItem, a as Listgroup } from "../../chunks/Listgroup.js";
import { L as Loader } from "../../chunks/Loader.js";
import { twMerge } from "tailwind-merge";
const Search = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["size", "placeholder", "value"]);
  let $$slots = compute_slots(slots);
  let { size = "lg" } = $$props;
  let { placeholder = "Search" } = $$props;
  let { value = void 0 } = $$props;
  const sizes = {
    sm: "w-3.5 h-3.5",
    md: "w-5 h-5",
    lg: "w-6 h-6"
  };
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.placeholder === void 0 && $$bindings.placeholder && placeholder !== void 0)
    $$bindings.placeholder(placeholder);
  if ($$props.value === void 0 && $$bindings.value && value !== void 0)
    $$bindings.value(value);
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    $$rendered = `${validate_component(Wrapper, "Wrapper").$$render(
      $$result,
      {
        class: "relative w-full",
        show: $$slots.default
      },
      {},
      {
        default: () => {
          return `${validate_component(Input, "Input").$$render(
            $$result,
            Object.assign({}, { type: "search" }, { placeholder }, { size }, $$restProps, { class: $$props.class }, { value }),
            {
              value: ($$value) => {
                value = $$value;
                $$settled = false;
              }
            },
            {
              left: () => {
                return `<svg slot="left"${add_attribute("class", sizes[size], 0)} fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"></path></svg>`;
              }
            }
          )}  ${$$slots.default ? `<div class="flex absolute inset-y-0 right-0 items-center text-gray-500 dark:text-gray-400">${slots.default ? slots.default({}) : ``}</div>` : ``}`;
        }
      }
    )} `;
  } while (!$$settled);
  return $$rendered;
});
const GridOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["size", "role", "strokeLinecap", "strokeLinejoin", "strokeWidth", "ariaLabel"]);
  let { size = "md" } = $$props;
  let { role = "img" } = $$props;
  const sizes = {
    xs: "w-3 h-3",
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
    xl: "w-8 h-8"
  };
  let { strokeLinecap = "round" } = $$props;
  let { strokeLinejoin = "round" } = $$props;
  let { strokeWidth = "2" } = $$props;
  let { ariaLabel = "grid outline" } = $$props;
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.role === void 0 && $$bindings.role && role !== void 0)
    $$bindings.role(role);
  if ($$props.strokeLinecap === void 0 && $$bindings.strokeLinecap && strokeLinecap !== void 0)
    $$bindings.strokeLinecap(strokeLinecap);
  if ($$props.strokeLinejoin === void 0 && $$bindings.strokeLinejoin && strokeLinejoin !== void 0)
    $$bindings.strokeLinejoin(strokeLinejoin);
  if ($$props.strokeWidth === void 0 && $$bindings.strokeWidth && strokeWidth !== void 0)
    $$bindings.strokeWidth(strokeWidth);
  if ($$props.ariaLabel === void 0 && $$bindings.ariaLabel && ariaLabel !== void 0)
    $$bindings.ariaLabel(ariaLabel);
  return `<svg${spread(
    [
      { xmlns: "http://www.w3.org/2000/svg" },
      { fill: "none" },
      escape_object($$restProps),
      {
        class: escape_attribute_value(twMerge("shrink-0", sizes[size], $$props.class))
      },
      { role: escape_attribute_value(role) },
      {
        "aria-label": escape_attribute_value(ariaLabel)
      },
      { viewBox: "0 0 18 18" }
    ],
    {}
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M6.143 1H1.857A.857.857 0 0 0 1 1.857v4.286c0 .473.384.857.857.857h4.286A.857.857 0 0 0 7 6.143V1.857A.857.857 0 0 0 6.143 1Zm10 0h-4.286a.857.857 0 0 0-.857.857v4.286c0 .473.384.857.857.857h4.286A.857.857 0 0 0 17 6.143V1.857A.857.857 0 0 0 16.143 1Zm-10 10H1.857a.857.857 0 0 0-.857.857v4.286c0 .473.384.857.857.857h4.286A.857.857 0 0 0 7 16.143v-4.286A.857.857 0 0 0 6.143 11Zm10 0h-4.286a.857.857 0 0 0-.857.857v4.286c0 .473.384.857.857.857h4.286a.857.857 0 0 0 .857-.857v-4.286a.857.857 0 0 0-.857-.857Z"></path></svg> `;
});
const ListOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["size", "role", "strokeLinecap", "strokeWidth", "ariaLabel"]);
  let { size = "md" } = $$props;
  let { role = "img" } = $$props;
  const sizes = {
    xs: "w-3 h-3",
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
    xl: "w-8 h-8"
  };
  let { strokeLinecap = "round" } = $$props;
  let { strokeWidth = "2" } = $$props;
  let { ariaLabel = "list outline" } = $$props;
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.role === void 0 && $$bindings.role && role !== void 0)
    $$bindings.role(role);
  if ($$props.strokeLinecap === void 0 && $$bindings.strokeLinecap && strokeLinecap !== void 0)
    $$bindings.strokeLinecap(strokeLinecap);
  if ($$props.strokeWidth === void 0 && $$bindings.strokeWidth && strokeWidth !== void 0)
    $$bindings.strokeWidth(strokeWidth);
  if ($$props.ariaLabel === void 0 && $$bindings.ariaLabel && ariaLabel !== void 0)
    $$bindings.ariaLabel(ariaLabel);
  return `<svg${spread(
    [
      { xmlns: "http://www.w3.org/2000/svg" },
      { fill: "none" },
      escape_object($$restProps),
      {
        class: escape_attribute_value(twMerge("shrink-0", sizes[size], $$props.class))
      },
      { role: escape_attribute_value(role) },
      {
        "aria-label": escape_attribute_value(ariaLabel)
      },
      { viewBox: "0 0 17 10" }
    ],
    {}
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M6 1h10M6 5h10M6 9h10M1.49 1h.01m-.01 4h.01m-.01 4h.01"></path></svg> `;
});
const SortOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["size", "role", "strokeLinecap", "strokeLinejoin", "strokeWidth", "ariaLabel"]);
  let { size = "md" } = $$props;
  let { role = "img" } = $$props;
  const sizes = {
    xs: "w-3 h-3",
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
    xl: "w-8 h-8"
  };
  let { strokeLinecap = "round" } = $$props;
  let { strokeLinejoin = "round" } = $$props;
  let { strokeWidth = "2" } = $$props;
  let { ariaLabel = "sort outline" } = $$props;
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.role === void 0 && $$bindings.role && role !== void 0)
    $$bindings.role(role);
  if ($$props.strokeLinecap === void 0 && $$bindings.strokeLinecap && strokeLinecap !== void 0)
    $$bindings.strokeLinecap(strokeLinecap);
  if ($$props.strokeLinejoin === void 0 && $$bindings.strokeLinejoin && strokeLinejoin !== void 0)
    $$bindings.strokeLinejoin(strokeLinejoin);
  if ($$props.strokeWidth === void 0 && $$bindings.strokeWidth && strokeWidth !== void 0)
    $$bindings.strokeWidth(strokeWidth);
  if ($$props.ariaLabel === void 0 && $$bindings.ariaLabel && ariaLabel !== void 0)
    $$bindings.ariaLabel(ariaLabel);
  return `<svg${spread(
    [
      { xmlns: "http://www.w3.org/2000/svg" },
      { fill: "none" },
      escape_object($$restProps),
      {
        class: escape_attribute_value(twMerge("shrink-0", sizes[size], $$props.class))
      },
      { role: escape_attribute_value(role) },
      {
        "aria-label": escape_attribute_value(ariaLabel)
      },
      { viewBox: "0 0 14 20" }
    ],
    {}
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M4 8.693v9.477m0 0 3-2.843M4 18.17l-3-2.843m9-4.739V1.111m0 0L7 3.954m3-2.843 3 2.843"></path></svg> `;
});
const CatalogItem = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let firstUnreadVolume;
  let firstVolume;
  let volume;
  let isComplete;
  let $volumes, $$unsubscribe_volumes;
  let $progress, $$unsubscribe_progress;
  $$unsubscribe_volumes = subscribe(volumes, (value) => $volumes = value);
  $$unsubscribe_progress = subscribe(progress, (value) => $progress = value);
  let { series_uuid } = $$props;
  if ($$props.series_uuid === void 0 && $$bindings.series_uuid && series_uuid !== void 0)
    $$bindings.series_uuid(series_uuid);
  firstUnreadVolume = Object.values($volumes).sort((a, b) => a.volume_title.localeCompare(b.volume_title)).find((item) => item.series_uuid === series_uuid && ($progress?.[item.volume_uuid || 0] || 1) < item.page_count - 1);
  firstVolume = Object.values($volumes).sort((a, b) => a.volume_title.localeCompare(b.volume_title)).find((item) => item.series_uuid === series_uuid);
  volume = firstUnreadVolume ?? firstVolume;
  isComplete = !firstUnreadVolume;
  $$unsubscribe_volumes();
  $$unsubscribe_progress();
  return `${volume ? `<a${add_attribute("href", series_uuid, 0)}><div class="${[
    "flex flex-col gap-[5px] text-center items-center bg-slate-900 pb-1 bg-opacity-50 border border-slate-950",
    isComplete ? "text-green-400" : ""
  ].join(" ").trim()}">${volume.thumbnail ? `<img${add_attribute("src", URL.createObjectURL(volume.thumbnail), 0)} alt="img" class="object-contain sm:w-[250px] sm:h-[350px] bg-black border-gray-900 border">` : ``} <p class="font-semibold sm:w-[250px] line-clamp-1">${escape(volume.series_title)}</p></div></a>` : ``}`;
});
const CatalogListItem = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let firstUnreadVolume;
  let firstVolume;
  let volume;
  let isComplete;
  let $volumes, $$unsubscribe_volumes;
  let $progress, $$unsubscribe_progress;
  $$unsubscribe_volumes = subscribe(volumes, (value) => $volumes = value);
  $$unsubscribe_progress = subscribe(progress, (value) => $progress = value);
  let { series_uuid } = $$props;
  if ($$props.series_uuid === void 0 && $$bindings.series_uuid && series_uuid !== void 0)
    $$bindings.series_uuid(series_uuid);
  firstUnreadVolume = Object.values($volumes).sort((a, b) => a.volume_title.localeCompare(b.volume_title)).find((item) => item.series_uuid === series_uuid && ($progress?.[item.volume_uuid || 0] || 1) < item.page_count - 1);
  firstVolume = Object.values($volumes).sort((a, b) => a.volume_title.localeCompare(b.volume_title)).find((item) => item.series_uuid === series_uuid);
  volume = firstUnreadVolume ?? firstVolume;
  isComplete = !firstUnreadVolume;
  $$unsubscribe_volumes();
  $$unsubscribe_progress();
  return `${volume ? `<div>${validate_component(ListgroupItem, "ListgroupItem").$$render($$result, {}, {}, {
    default: () => {
      return `<a${add_attribute("href", series_uuid, 0)} class="h-full w-full"><div class="flex justify-between items-center"><p class="${["font-semibold", isComplete ? "text-green-400" : ""].join(" ").trim()}">${escape(volume.series_title)}</p> ${volume.thumbnail ? `<img${add_attribute("src", URL.createObjectURL(volume.thumbnail), 0)} alt="img" class="object-contain w-[50px] h-[70px] bg-black border-gray-900 border">` : ``}</div></a>`;
    }
  })}</div>` : ``}`;
});
const Catalog = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let sortedCatalog;
  let $miscSettings, $$unsubscribe_miscSettings;
  let $volumes, $$unsubscribe_volumes;
  let $catalog, $$unsubscribe_catalog;
  let $isUpgrading, $$unsubscribe_isUpgrading;
  $$unsubscribe_miscSettings = subscribe(miscSettings, (value) => $miscSettings = value);
  $$unsubscribe_volumes = subscribe(volumes$1, (value) => $volumes = value);
  $$unsubscribe_catalog = subscribe(catalog, (value) => $catalog = value);
  $$unsubscribe_isUpgrading = subscribe(isUpgrading, (value) => $isUpgrading = value);
  let search = "";
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    sortedCatalog = $catalog.sort((a, b) => {
      if ($miscSettings.gallerySorting === "ASC") {
        return a.title.localeCompare(b.title, void 0, { numeric: true, sensitivity: "base" });
      } else if ($miscSettings.gallerySorting === "DESC") {
        return b.title.localeCompare(a.title, void 0, { numeric: true, sensitivity: "base" });
      } else {
        const aVolumes = a.volumes.map((vol) => vol.volume_uuid);
        const bVolumes = b.volumes.map((vol) => vol.volume_uuid);
        const aCompleted = aVolumes.every((volId) => $volumes[volId]?.completed);
        const bCompleted = bVolumes.every((volId) => $volumes[volId]?.completed);
        if (aCompleted !== bCompleted) {
          return aCompleted ? 1 : -1;
        }
        const aLastUpdated = Math.max(...aVolumes.map((volId) => new Date($volumes[volId]?.lastProgressUpdate || 0).getTime()));
        const bLastUpdated = Math.max(...bVolumes.map((volId) => new Date($volumes[volId]?.lastProgressUpdate || 0).getTime()));
        if (aLastUpdated !== bLastUpdated) {
          return bLastUpdated - aLastUpdated;
        }
        return a.title.localeCompare(b.title, void 0, { numeric: true, sensitivity: "base" });
      }
    }).filter((item) => {
      return item.title.toLowerCase().indexOf(search.toLowerCase()) !== -1;
    });
    $$rendered = `${$catalog ? `${$catalog.length > 0 ? `<div class="flex flex-col gap-5"><div class="flex gap-1 py-2">${validate_component(Search, "Search").$$render(
      $$result,
      { value: search },
      {
        value: ($$value) => {
          search = $$value;
          $$settled = false;
        }
      },
      {}
    )} ${validate_component(Button, "Button").$$render($$result, { size: "sm", color: "alternative" }, {}, {
      default: () => {
        return `${$miscSettings.galleryLayout === "list" ? `${validate_component(GridOutline, "GridOutline").$$render($$result, {}, {}, {})}` : `${validate_component(ListOutline, "ListOutline").$$render($$result, {}, {}, {})}`}`;
      }
    })} ${validate_component(Button, "Button").$$render($$result, { size: "sm", color: "alternative" }, {}, {
      default: () => {
        return `${validate_component(SortOutline, "SortOutline").$$render($$result, {}, {}, {})} <span class="ml-1 text-xs">${$miscSettings.gallerySorting === "ASC" ? `A-Z` : `${$miscSettings.gallerySorting === "DESC" ? `Z-A` : `Smart`}`}</span>`;
      }
    })}</div> ${search && sortedCatalog.length === 0 ? `<div class="text-center p-20" data-svelte-h="svelte-11xng1f"><p>No results found.</p></div>` : `<div class="flex sm:flex-row flex-col gap-5 flex-wrap justify-center sm:justify-start">${$miscSettings.galleryLayout === "grid" ? `${each(sortedCatalog, ({ series_uuid }) => {
      return `${validate_component(CatalogItem, "CatalogItem").$$render($$result, { series_uuid }, {}, {})}`;
    })}` : `${validate_component(Listgroup, "Listgroup").$$render($$result, { active: true, class: "w-full" }, {}, {
      default: () => {
        return `${each(sortedCatalog, ({ series_uuid }) => {
          return `${validate_component(CatalogListItem, "CatalogListItem").$$render($$result, { series_uuid }, {}, {})}`;
        })}`;
      }
    })}`}</div>`}</div>` : `<div class="text-center p-20">${$isUpgrading ? `<p data-svelte-h="svelte-19c2omk">Upgrading and optimizing manga catalog... Please wait.</p>` : `<p data-svelte-h="svelte-z4oj1">Your catalog is currently empty.</p>`}</div>`}` : `${validate_component(Loader, "Loader").$$render($$result, {}, {}, {
      default: () => {
        return `Fetching catalog...`;
      }
    })}`}`;
  } while (!$$settled);
  $$unsubscribe_miscSettings();
  $$unsubscribe_volumes();
  $$unsubscribe_catalog();
  $$unsubscribe_isUpgrading();
  return $$rendered;
});
const Page = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  return `${$$result.head += `<!-- HEAD_svelte-1nqbgkc_START -->${$$result.title = `<title>Mokuro</title>`, ""}<!-- HEAD_svelte-1nqbgkc_END -->`, ""} <div class="p-2 h-[90svh]">${validate_component(Catalog, "Catalog").$$render($$result, {}, {}, {})}</div>`;
});
export {
  Page as default
};
