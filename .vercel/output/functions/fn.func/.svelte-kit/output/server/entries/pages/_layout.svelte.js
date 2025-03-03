import { c as create_ssr_component, a as compute_rest_props, b as add_attribute, d as spread, e as escape_object, v as validate_component, f as escape_attribute_value, g as escape, h as createEventDispatcher, i as compute_slots, j as is_promise, n as noop, k as subscribe, l as each } from "../../chunks/ssr.js";
import { inject } from "@vercel/analytics";
import "../../chunks/db.js";
import { F as Frame } from "../../chunks/Listgroup.js";
import { twMerge, twJoin } from "tailwind-merge";
import { f as fade, C as CloseButton, A, M as Modal, a as Accordion, b as AccordionItem, c as afterNavigate, U as UserSettingsSolid, S as Settings, T as Toggle } from "../../chunks/Settings.js";
import { p as page } from "../../chunks/stores.js";
import { B as Button } from "../../chunks/misc.js";
import { S as Spinner } from "../../chunks/Spinner.js";
import "@zip.js/zip.js";
import { s as snackbarStore, p as progressTrackerStore } from "../../chunks/progress-tracker.js";
import { w as writable } from "../../chunks/index.js";
const app = "";
const Dropzone = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["value", "files", "defaultClass"]);
  let { value = "" } = $$props;
  let { files = void 0 } = $$props;
  let { defaultClass = "flex flex-col justify-center items-center w-full h-64 bg-gray-50 rounded-lg border-2 border-gray-300 border-dashed cursor-pointer dark:hover:bg-bray-800 dark:bg-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:hover:border-gray-500 dark:hover:bg-gray-600" } = $$props;
  if ($$props.value === void 0 && $$bindings.value && value !== void 0)
    $$bindings.value(value);
  if ($$props.files === void 0 && $$bindings.files && files !== void 0)
    $$bindings.files(files);
  if ($$props.defaultClass === void 0 && $$bindings.defaultClass && defaultClass !== void 0)
    $$bindings.defaultClass(defaultClass);
  return `<button${add_attribute("class", twMerge(defaultClass, $$props.class), 0)} type="button"><label class="flex flex-col items-center" tabindex="0">${slots.default ? slots.default({}) : ``} <input${spread([escape_object($$restProps), { type: "file" }, { class: "hidden" }], {})}></label></button> `;
});
const Navbar = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["navClass", "navDivClass", "fluid"]);
  let { navClass = "px-2 sm:px-4 py-2.5 w-full" } = $$props;
  let { navDivClass = "mx-auto flex flex-wrap justify-between items-center " } = $$props;
  let { fluid = false } = $$props;
  let hidden = true;
  let toggle = () => {
    hidden = !hidden;
  };
  if ($$props.navClass === void 0 && $$bindings.navClass && navClass !== void 0)
    $$bindings.navClass(navClass);
  if ($$props.navDivClass === void 0 && $$bindings.navDivClass && navDivClass !== void 0)
    $$bindings.navDivClass(navDivClass);
  if ($$props.fluid === void 0 && $$bindings.fluid && fluid !== void 0)
    $$bindings.fluid(fluid);
  {
    {
      $$restProps.color = $$restProps.color ?? "navbar";
    }
  }
  return `${validate_component(Frame, "Frame").$$render($$result, Object.assign({}, { tag: "nav" }, $$restProps, { class: twMerge(navClass, $$props.class) }), {}, {
    default: () => {
      return `<div${add_attribute("class", twMerge(navDivClass, $$props.classNavDiv, fluid && "w-full" || "container"), 0)}>${slots.default ? slots.default({ hidden, toggle }) : ``}</div>`;
    }
  })} `;
});
const NavBrand = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["href"]);
  let { href = "" } = $$props;
  if ($$props.href === void 0 && $$bindings.href && href !== void 0)
    $$bindings.href(href);
  return `<a${spread(
    [
      { href: escape_attribute_value(href) },
      escape_object($$restProps),
      {
        class: escape_attribute_value(twMerge("flex items-center", $$props.class))
      }
    ],
    {}
  )}>${slots.default ? slots.default({}) : ``}</a> `;
});
const Progressbar = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, [
    "progress",
    "size",
    "labelInside",
    "labelOutside",
    "color",
    "labelInsideClass",
    "divClass"
  ]);
  let { progress = "45" } = $$props;
  let { size = "h-2.5" } = $$props;
  let { labelInside = false } = $$props;
  let { labelOutside = "" } = $$props;
  let { color = "primary" } = $$props;
  let { labelInsideClass = "text-primary-100 text-xs font-medium text-center p-0.5 leading-none rounded-full" } = $$props;
  let { divClass = "w-full bg-gray-200 rounded-full dark:bg-gray-700" } = $$props;
  const barColors = {
    primary: "bg-primary-600",
    blue: "bg-blue-600",
    gray: "bg-gray-600 dark:bg-gray-300",
    red: "bg-red-600 dark:bg-red-500",
    green: "bg-green-600 dark:bg-green-500",
    yellow: "bg-yellow-400",
    purple: "bg-purple-600 dark:bg-purple-500",
    indigo: "bg-indigo-600 dark:bg-indigo-500"
  };
  if ($$props.progress === void 0 && $$bindings.progress && progress !== void 0)
    $$bindings.progress(progress);
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.labelInside === void 0 && $$bindings.labelInside && labelInside !== void 0)
    $$bindings.labelInside(labelInside);
  if ($$props.labelOutside === void 0 && $$bindings.labelOutside && labelOutside !== void 0)
    $$bindings.labelOutside(labelOutside);
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  if ($$props.labelInsideClass === void 0 && $$bindings.labelInsideClass && labelInsideClass !== void 0)
    $$bindings.labelInsideClass(labelInsideClass);
  if ($$props.divClass === void 0 && $$bindings.divClass && divClass !== void 0)
    $$bindings.divClass(divClass);
  return `${labelOutside ? `<div${spread(
    [
      escape_object($$restProps),
      {
        class: escape_attribute_value(twMerge("flex justify-between mb-1", $$props.classLabelOutside))
      }
    ],
    {}
  )}><span class="text-base font-medium text-blue-700 dark:text-white">${escape(labelOutside)}</span> <span class="text-sm font-medium text-blue-700 dark:text-white">${escape(progress)}%</span></div>` : ``} <div${add_attribute("class", twMerge(divClass, size, $$props.class), 0)}>${labelInside ? `<div${add_attribute("class", twJoin(labelInsideClass, barColors[color]), 0)} style="${"width: " + escape(progress, true) + "%"}">${escape(progress)}%</div>` : `<div${add_attribute("class", twJoin(barColors[color], size, "rounded-full"), 0)} style="${"width: " + escape(progress, true) + "%"}"></div>`}</div> `;
});
const clsBtnExtraClass = "-mx-1.5 -my-1.5 text-gray-400 hover:text-gray-900 focus:!ring-gray-300 hover:bg-gray-100 dark:text-gray-500 dark:hover:text-white dark:hover:bg-gray-700";
const Toast = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, [
    "dismissable",
    "color",
    "position",
    "open",
    "divClass",
    "defaultIconClass",
    "contentClass",
    "align"
  ]);
  let $$slots = compute_slots(slots);
  let { dismissable = true } = $$props;
  let { color = "primary" } = $$props;
  let { position = "none" } = $$props;
  let { open = true } = $$props;
  let { divClass = "w-full max-w-xs p-4 text-gray-500 bg-white shadow dark:text-gray-400 dark:bg-gray-800 gap-3" } = $$props;
  let { defaultIconClass = "w-8 h-8" } = $$props;
  let { contentClass = "w-full text-sm font-normal" } = $$props;
  let { align = true } = $$props;
  const dispatch = createEventDispatcher();
  const positions = {
    "top-left": "absolute top-5 left-5",
    "top-right": "absolute top-5 right-5",
    "bottom-left": "absolute bottom-5 left-5",
    "bottom-right": "absolute bottom-5 right-5",
    none: ""
  };
  function close(e) {
    e.stopPropagation();
    open = false;
  }
  let finalDivClass;
  const colors = {
    primary: "text-primary-500 bg-primary-100 dark:bg-primary-800 dark:text-primary-200",
    gray: "text-gray-500 bg-gray-100 dark:bg-gray-700 dark:text-gray-200",
    red: "text-red-500 bg-red-100 dark:bg-red-800 dark:text-red-200",
    yellow: "text-yellow-500 bg-yellow-100 dark:bg-yellow-800 dark:text-yellow-200",
    green: "text-green-500 bg-green-100 dark:bg-green-800 dark:text-green-200",
    blue: "text-blue-500 bg-blue-100 dark:bg-blue-800 dark:text-blue-200",
    indigo: "text-indigo-500 bg-indigo-100 dark:bg-indigo-800 dark:text-indigo-200",
    purple: "text-purple-500 bg-purple-100 dark:bg-purple-800 dark:text-purple-200",
    orange: "text-orange-500 bg-orange-100 dark:bg-orange-700 dark:text-orange-200",
    none: ""
  };
  let iconClass;
  if ($$props.dismissable === void 0 && $$bindings.dismissable && dismissable !== void 0)
    $$bindings.dismissable(dismissable);
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  if ($$props.position === void 0 && $$bindings.position && position !== void 0)
    $$bindings.position(position);
  if ($$props.open === void 0 && $$bindings.open && open !== void 0)
    $$bindings.open(open);
  if ($$props.divClass === void 0 && $$bindings.divClass && divClass !== void 0)
    $$bindings.divClass(divClass);
  if ($$props.defaultIconClass === void 0 && $$bindings.defaultIconClass && defaultIconClass !== void 0)
    $$bindings.defaultIconClass(defaultIconClass);
  if ($$props.contentClass === void 0 && $$bindings.contentClass && contentClass !== void 0)
    $$bindings.contentClass(contentClass);
  if ($$props.align === void 0 && $$bindings.align && align !== void 0)
    $$bindings.align(align);
  {
    dispatch(open ? "open" : "close");
  }
  finalDivClass = twMerge("flex", align ? "items-center" : "items-start", divClass, positions[position], $$props.class);
  iconClass = twMerge("inline-flex items-center justify-center shrink-0", colors[color], defaultIconClass);
  return `${open ? `${validate_component(Frame, "Frame").$$render($$result, Object.assign({}, { rounded: true }, { transition: fade }, { color: "none" }, $$restProps, { class: finalDivClass }, { role: "alert" }), {}, {
    default: () => {
      return `${$$slots.icon ? `${validate_component(Frame, "Frame").$$render(
        $$result,
        {
          rounded: true,
          color: "none",
          class: iconClass
        },
        {},
        {
          default: () => {
            return `${slots.icon ? slots.icon({}) : ``}`;
          }
        }
      )}` : ``} <div${add_attribute("class", contentClass, 0)}>${slots.default ? slots.default({}) : ``}</div> ${dismissable ? `${slots["close-button"] ? slots["close-button"]({ close }) : ` ${validate_component(CloseButton, "CloseButton").$$render($$result, { class: clsBtnExtraClass }, {}, {})} `}` : ``}`;
    }
  })}` : ``} `;
});
const ChevronDownSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "chevron down solid" } = $$props;
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
      { viewBox: "0 0 10 6" }
    ],
    {}
  )}><path fill="currentColor" d="M5.012 6a1 1 0 0 1-.707-.292l-4-3.992A.998.998 0 0 1 1.395.08a1 1 0 0 1 .324.224L5.012 3.59 8.305.305A1.001 1.001 0 0 1 10 1.014a.997.997 0 0 1-.28.702l-4 3.992A1.001 1.001 0 0 1 5.011 6Z"></path></svg> `;
});
const CloseSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "close solid" } = $$props;
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
      { viewBox: "0 0 16 16" }
    ],
    {}
  )}><path fill="currentColor" d="m9.414 8 5.293-5.293a1 1 0 1 0-1.414-1.414L8 6.586 2.707 1.293a1 1 0 0 0-1.414 1.414L6.586 8l-5.293 5.293a1 1 0 1 0 1.414 1.414L8 9.414l5.293 5.293a1 1 0 0 0 1.414-1.414L9.414 8Z"></path></svg> `;
});
const CloudArrowUpOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "cloud arrow up outline" } = $$props;
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
      { viewBox: "0 0 20 16" }
    ],
    {}
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M13 13h3a3 3 0 0 0 0-6h-.025A5.56 5.56 0 0 0 16 6.5 5.5 5.5 0 0 0 5.207 5.021C5.137 5.017 5.071 5 5 5a4 4 0 0 0 0 8h2.167M10 15V6m0 0L8 8m2-2 2 2"></path></svg> `;
});
const ExclamationCircleOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "exclamation circle outline" } = $$props;
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
      { viewBox: "0 0 20 20" }
    ],
    {}
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M10 11V6m0 8h.01M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"></path></svg> `;
});
const UploadSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "upload solid" } = $$props;
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
  )}><g fill="currentColor"><path d="m14.707 4.793-4-4a1 1 0 0 0-1.416 0l-4 4a1 1 0 0 0 1.416 1.414L9 3.914V12.5a1 1 0 1 0 2 0V3.914l2.293 2.293a1 1 0 0 0 1.414-1.414Z"></path><path d="M18 12h-5v.5a3 3 0 0 1-6 0V12H2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2Zm-3 5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></g></svg> `;
});
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0)
    return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}
const confirmationPopupStore = writable(void 0);
const extractionModalStore = writable(void 0);
const FileUpload = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["files", "onUpload"]);
  let { files = void 0 } = $$props;
  let { onUpload = void 0 } = $$props;
  if ($$props.files === void 0 && $$bindings.files && files !== void 0)
    $$bindings.files(files);
  if ($$props.onUpload === void 0 && $$bindings.onUpload && onUpload !== void 0)
    $$bindings.onUpload(onUpload);
  return `<input${spread([{ type: "file" }, escape_object($$restProps), { class: "hidden" }], {})}> ${validate_component(A, "A").$$render($$result, {}, {}, {
    default: () => {
      return `${slots.default ? slots.default({}) : `Upload`}`;
    }
  })}`;
});
let defaultStyle = "flex flex-col justify-center items-center w-full h-64 bg-gray-50 rounded-lg border-2 border-gray-300 border-dashed cursor-pointer dark:hover:bg-bray-800 dark:bg-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:hover:border-gray-500 dark:hover:bg-gray-600";
const UploadModal = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let disabled;
  let { open = false } = $$props;
  let promise;
  let files = void 0;
  let storageSpace = "";
  let activeStyle = defaultStyle;
  if ($$props.open === void 0 && $$bindings.open && open !== void 0)
    $$bindings.open(open);
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    disabled = !files;
    $$rendered = `${validate_component(Modal, "Modal").$$render(
      $$result,
      {
        title: "Upload",
        outsideclose: true,
        open
      },
      {
        open: ($$value) => {
          open = $$value;
          $$settled = false;
        }
      },
      {
        default: () => {
          return `${function(__value) {
            if (is_promise(__value)) {
              __value.then(null, noop);
              return ` <h2 class="justify-center flex" data-svelte-h="svelte-l03awi">Loading...</h2> <div class="text-center">${validate_component(Spinner, "Spinner").$$render($$result, {}, {}, {})}</div> `;
            }
            return function() {
              return ` ${validate_component(Accordion, "Accordion").$$render($$result, { flush: true }, {}, {
                default: () => {
                  return `${validate_component(AccordionItem, "AccordionItem").$$render($$result, {}, {}, {
                    header: () => {
                      return `<span slot="header" data-svelte-h="svelte-195lspx">What to upload?</span>`;
                    },
                    default: () => {
                      return `<div class="flex flex-col gap-5"><div><p data-svelte-h="svelte-10ll4j8">Firstly, ensure that you process your manga with the <b>0.2.0-beta.6</b> of mokuro, you
              can install it by running the following command:</p> <div role="none" data-svelte-h="svelte-1u5h4pg"><code class="text-primary-600 bg-slate-900">pip3 install git+https://github.com/kha-white/mokuro.git@web-reader</code></div></div> <p data-svelte-h="svelte-17zan5x">This will generate a <code>.mokuro</code> file for each volume processed, upload your
            manga along with the <code>.mokuro</code> files.</p> <p data-svelte-h="svelte-rpz4qa">On mobile, uploading via directory is not supported so you will need to zip your manga
            first and then upload it via
            <code class="text-primary-600 bg-slate-900">choose files</code>.</p></div>`;
                    }
                  })}`;
                }
              })} ${validate_component(Dropzone, "Dropzone").$$render(
                $$result,
                {
                  id: "dropzone",
                  defaultClass: activeStyle
                },
                {},
                {
                  default: () => {
                    return `<svg aria-hidden="true" class="mb-3 w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg> ${files ? `<p class="mb-2 text-sm text-gray-500 dark:text-gray-400">Upload ${escape(files.length)} ${escape(files.length > 1 ? "files" : "file")}?</p>` : `${`${`<p class="mb-2 text-sm text-gray-500 dark:text-gray-400">Drag and drop / ${validate_component(FileUpload, "FileUpload").$$render(
                      $$result,
                      {
                        accept: ".mokuro,.zip,.cbz",
                        multiple: true,
                        files
                      },
                      {
                        files: ($$value) => {
                          files = $$value;
                          $$settled = false;
                        }
                      },
                      {
                        default: () => {
                          return `choose files`;
                        }
                      }
                    )} /
          ${validate_component(FileUpload, "FileUpload").$$render(
                      $$result,
                      { webkitdirectory: true, files },
                      {
                        files: ($$value) => {
                          files = $$value;
                          $$settled = false;
                        }
                      },
                      {
                        default: () => {
                          return `choose directory`;
                        }
                      }
                    )}</p>`}`}`}`;
                  }
                }
              )} <p class="text-sm text-gray-500 dark:text-gray-400 text-center">${escape(storageSpace)}</p> <div class="flex flex-1 flex-col gap-2">${validate_component(Button, "Button").$$render($$result, { outline: true, disabled, color: "dark" }, {}, {
                default: () => {
                  return `Reset`;
                }
              })} ${validate_component(Button, "Button").$$render($$result, { outline: true, disabled }, {}, {
                default: () => {
                  return `Upload`;
                }
              })}</div> `;
            }();
          }(promise)}`;
        }
      }
    )}`;
  } while (!$$settled);
  return $$rendered;
});
const Icon = "/_app/immutable/assets/icon.06fcfdd6.webp";
const NavBar = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $page, $$unsubscribe_page;
  $$unsubscribe_page = subscribe(page, (value) => $page = value);
  let settingsHidden = true;
  let uploadModalOpen = false;
  let isReader = false;
  afterNavigate(() => {
    isReader = $page.route.id === "/[manga]/[volume]";
    if (isReader) {
      window.document.body.classList.add("reader");
    } else {
      window.document.body.classList.remove("reader");
    }
  });
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    $$rendered = `<div class="relative z-10">${validate_component(Navbar, "Navbar").$$render($$result, { hidden: isReader }, {}, {
      default: () => {
        return `${validate_component(NavBrand, "NavBrand").$$render($$result, { href: "/" }, {}, {
          default: () => {
            return `<div class="flex flex-row gap-2 items-center" data-svelte-h="svelte-w5ggo3"><img${add_attribute("src", Icon, 0)} alt="icon" class="w-[32px] h-[32px]"> <span class="text-xl font-semibold dark:text-white">Mokuro</span></div>`;
          }
        })} <div class="flex md:order-2 gap-5">${validate_component(UserSettingsSolid, "UserSettingsSolid").$$render($$result, { class: "hover:text-primary-700" }, {}, {})} ${validate_component(UploadSolid, "UploadSolid").$$render($$result, { class: "hover:text-primary-700" }, {}, {})} ${validate_component(CloudArrowUpOutline, "CloudArrowUpOutline").$$render($$result, { class: "hover:text-primary-700" }, {}, {})}</div>`;
      }
    })}</div> ${validate_component(Settings, "Settings").$$render(
      $$result,
      { hidden: settingsHidden },
      {
        hidden: ($$value) => {
          settingsHidden = $$value;
          $$settled = false;
        }
      },
      {}
    )} ${validate_component(UploadModal, "UploadModal").$$render(
      $$result,
      { open: uploadModalOpen },
      {
        open: ($$value) => {
          uploadModalOpen = $$value;
          $$settled = false;
        }
      },
      {}
    )}`;
  } while (!$$settled);
  $$unsubscribe_page();
  return $$rendered;
});
const Snackbar = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $snackbarStore, $$unsubscribe_snackbarStore;
  $$unsubscribe_snackbarStore = subscribe(snackbarStore, (value) => $snackbarStore = value);
  $$unsubscribe_snackbarStore();
  return `${$snackbarStore?.message && $snackbarStore?.visible ? `${validate_component(Toast, "Toast").$$render($$result, { position: "bottom-right", class: "z-50" }, {}, {
    default: () => {
      return `${escape($snackbarStore?.message)}`;
    }
  })}` : ``}`;
});
const ConfirmationPopup = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $confirmationPopupStore, $$unsubscribe_confirmationPopupStore;
  $$unsubscribe_confirmationPopupStore = subscribe(confirmationPopupStore, (value) => $confirmationPopupStore = value);
  let open = false;
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    $$rendered = `${validate_component(Modal, "Modal").$$render(
      $$result,
      {
        size: "xs",
        autoclose: true,
        outsideclose: true,
        open
      },
      {
        open: ($$value) => {
          open = $$value;
          $$settled = false;
        }
      },
      {
        default: () => {
          return `<div class="text-center">${validate_component(ExclamationCircleOutline, "ExclamationCircleOutline").$$render(
            $$result,
            {
              class: "mx-auto mb-4 text-gray-400 w-12 h-12 dark:text-gray-200"
            },
            {},
            {}
          )} <h3 class="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">${escape($confirmationPopupStore?.message)}</h3> ${validate_component(Button, "Button").$$render($$result, { color: "red", class: "mr-2" }, {}, {
            default: () => {
              return `Yes`;
            }
          })} ${validate_component(Button, "Button").$$render($$result, { color: "alternative" }, {}, {
            default: () => {
              return `No`;
            }
          })}</div>`;
        }
      }
    )}`;
  } while (!$$settled);
  $$unsubscribe_confirmationPopupStore();
  return $$rendered;
});
const ExtractionModal = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $extractionModalStore, $$unsubscribe_extractionModalStore;
  $$unsubscribe_extractionModalStore = subscribe(extractionModalStore, (value) => $extractionModalStore = value);
  let open = false;
  let asCbz = true;
  let individualVolumes = false;
  let includeSeriesTitle = true;
  let firstVolumePreview = "";
  function updateFilenamePreview(firstVolume) {
    if (firstVolume) {
      const extension = asCbz ? "cbz" : "zip";
      if (includeSeriesTitle && individualVolumes) {
        firstVolumePreview = `${firstVolume.series_title} - ${firstVolume.volume_title}.${extension}`;
      } else if (individualVolumes) {
        firstVolumePreview = `${firstVolume.volume_title}.${extension}`;
      } else {
        firstVolumePreview = `${firstVolume.series_title}.${extension}`;
      }
    }
  }
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    {
      if ($extractionModalStore?.firstVolume) {
        updateFilenamePreview($extractionModalStore.firstVolume);
      }
    }
    {
      if (asCbz !== void 0 || includeSeriesTitle !== void 0 || individualVolumes !== void 0) {
        if ($extractionModalStore?.firstVolume) {
          updateFilenamePreview($extractionModalStore.firstVolume);
        }
      }
    }
    $$rendered = `${validate_component(Modal, "Modal").$$render(
      $$result,
      {
        size: "md",
        autoclose: true,
        outsideclose: true,
        open
      },
      {
        open: ($$value) => {
          open = $$value;
          $$settled = false;
        }
      },
      {
        default: () => {
          return `<div class="text-center"><h3 class="mb-5 text-lg font-normal text-gray-700 dark:text-gray-300" data-svelte-h="svelte-d2poeh">Extract Options</h3> <div class="flex flex-col gap-4 mb-5"><div class="flex items-center justify-between"><span class="text-sm font-medium text-gray-700 dark:text-gray-300" data-svelte-h="svelte-1yx4bvq">Extract as CBZ</span> ${validate_component(Toggle, "Toggle").$$render(
            $$result,
            { checked: asCbz },
            {
              checked: ($$value) => {
                asCbz = $$value;
                $$settled = false;
              }
            },
            {}
          )}</div> <div class="flex items-center justify-between"><span class="text-sm font-medium text-gray-700 dark:text-gray-300" data-svelte-h="svelte-owoe69">Extract individual volumes</span> ${validate_component(Toggle, "Toggle").$$render(
            $$result,
            { checked: individualVolumes },
            {
              checked: ($$value) => {
                individualVolumes = $$value;
                $$settled = false;
              }
            },
            {}
          )}</div> ${individualVolumes ? `<div class="flex items-center justify-between"><span class="text-sm font-medium text-gray-700 dark:text-gray-300" data-svelte-h="svelte-17r1lnh">Include series title in filename</span> ${validate_component(Toggle, "Toggle").$$render(
            $$result,
            { checked: includeSeriesTitle },
            {
              checked: ($$value) => {
                includeSeriesTitle = $$value;
                $$settled = false;
              }
            },
            {}
          )}</div>` : ``} <div class="mt-2 p-3 bg-gray-100 dark:bg-gray-800 rounded-md"><div class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" data-svelte-h="svelte-bwria2">Filename preview:</div> <div class="text-xs font-mono break-all text-gray-600 dark:text-gray-400">${escape(firstVolumePreview)}</div></div></div> <div class="flex justify-center gap-2">${validate_component(Button, "Button").$$render($$result, { color: "blue" }, {}, {
            default: () => {
              return `Extract`;
            }
          })} ${validate_component(Button, "Button").$$render($$result, { color: "alternative" }, {}, {
            default: () => {
              return `Cancel`;
            }
          })}</div></div>`;
        }
      }
    )}`;
  } while (!$$settled);
  $$unsubscribe_extractionModalStore();
  return $$rendered;
});
const ProgressTracker = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $progressTrackerStore, $$unsubscribe_progressTrackerStore;
  $$unsubscribe_progressTrackerStore = subscribe(progressTrackerStore, (value) => $progressTrackerStore = value);
  $$unsubscribe_progressTrackerStore();
  return `${$progressTrackerStore.processes.length > 0 ? `<div class="fixed bottom-4 right-4 z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 w-80 overflow-hidden transition-all duration-200"><div class="flex justify-between items-center p-3 bg-primary-100 dark:bg-primary-900 cursor-pointer" role="button" tabindex="0"><div class="font-medium">${$progressTrackerStore.processes.length === 1 ? `${escape($progressTrackerStore.processes[0].description)}` : `${escape($progressTrackerStore.processes.length)} Background Tasks`}</div> <div>${`${validate_component(ChevronDownSolid, "ChevronDownSolid").$$render($$result, { class: "w-4 h-4" }, {}, {})}`}</div></div> ${`<div class="p-3 max-h-96 overflow-y-auto">${each($progressTrackerStore.processes, (process) => {
    return `<div class="mb-4 last:mb-0"><div class="flex justify-between items-center mb-1"><div class="text-sm font-medium">${escape(process.description)}</div> ${validate_component(Button, "Button").$$render($$result, { size: "xs", color: "none", class: "p-1" }, {}, {
      default: () => {
        return `${validate_component(CloseSolid, "CloseSolid").$$render($$result, { class: "w-3 h-3" }, {}, {})} `;
      }
    })}</div> ${process.status ? `<div class="text-xs text-gray-600 dark:text-gray-400 mb-1">${escape(process.status)}</div>` : ``} <div class="flex justify-between text-xs mb-1"><span>${escape(Math.round(process.progress))}%</span> ${process.bytesLoaded !== void 0 && process.totalBytes !== void 0 ? `<span>${escape(formatBytes(process.bytesLoaded))} / ${escape(formatBytes(process.totalBytes))}</span>` : ``}</div> ${validate_component(Progressbar, "Progressbar").$$render(
      $$result,
      {
        progress: process.progress.toString(),
        size: "h-2"
      },
      {},
      {}
    )} </div>`;
  })}</div>`}</div>` : ``}`;
});
const Layout = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  inject({ mode: "production" });
  return `<div class="h-full min-h-[100svh] text-white">${validate_component(NavBar, "NavBar").$$render($$result, {}, {}, {})} ${slots.default ? slots.default({}) : ``} ${validate_component(Snackbar, "Snackbar").$$render($$result, {}, {}, {})} ${validate_component(ConfirmationPopup, "ConfirmationPopup").$$render($$result, {}, {}, {})} ${validate_component(ExtractionModal, "ExtractionModal").$$render($$result, {}, {}, {})} ${validate_component(ProgressTracker, "ProgressTracker").$$render($$result, {}, {}, {})}</div>`;
});
export {
  Layout as default
};
