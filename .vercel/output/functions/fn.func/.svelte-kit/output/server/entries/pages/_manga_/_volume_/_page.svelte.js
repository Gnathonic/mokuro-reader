import { c as create_ssr_component, a as compute_rest_props, o as getContext, b as add_attribute, v as validate_component, p as get_current_component, g as escape, i as compute_slots, s as setContext, d as spread, e as escape_object, f as escape_attribute_value, q as get_store_value, k as subscribe, l as each, r as add_styles, h as createEventDispatcher$1, t as onDestroy } from "../../../../chunks/ssr.js";
import { p as page } from "../../../../chunks/stores.js";
import { B as Button, s as settings, d as currentSeries, p as progress, e as currentVolumeData, f as currentVolume, u as updateProgress, g as volumeStats, a as volumes, h as volumeSettings } from "../../../../chunks/misc.js";
import "panzoom";
import { w as writable } from "../../../../chunks/index.js";
import { d as clamp, c as afterNavigate, e as beforeNavigate, M as Modal, U as UserSettingsSolid, S as Settings, g as fireExstaticEvent, R as Range } from "../../../../chunks/Settings.js";
import "../../../../chunks/db.js";
import "@zip.js/zip.js";
import { I as Input } from "../../../../chunks/Input.js";
import * as dom from "@floating-ui/dom";
import { twMerge, twJoin } from "tailwind-merge";
import { F as Frame } from "../../../../chunks/Listgroup.js";
import { S as Spinner } from "../../../../chunks/Spinner.js";
const GradientButton = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["color", "shadow"]);
  const group = getContext("group");
  let { color = "blue" } = $$props;
  let { shadow = false } = $$props;
  const gradientClasses = {
    blue: "text-white bg-gradient-to-r from-blue-500 via-blue-600 to-blue-700 hover:bg-gradient-to-br focus:ring-blue-300 dark:focus:ring-blue-800 ",
    green: "text-white bg-gradient-to-r from-green-400 via-green-500 to-green-600 hover:bg-gradient-to-br focus:ring-green-300 dark:focus:ring-green-800",
    cyan: "text-white bg-gradient-to-r from-cyan-400 via-cyan-500 to-cyan-600 hover:bg-gradient-to-br focus:ring-cyan-300 dark:focus:ring-cyan-800",
    teal: "text-white bg-gradient-to-r from-teal-400 via-teal-500 to-teal-600 hover:bg-gradient-to-br focus:ring-teal-300 dark:focus:ring-teal-800",
    lime: "text-gray-900 bg-gradient-to-r from-lime-200 via-lime-400 to-lime-500 hover:bg-gradient-to-br focus:ring-lime-300 dark:focus:ring-lime-800",
    red: "text-white bg-gradient-to-r from-red-400 via-red-500 to-red-600 hover:bg-gradient-to-br focus:ring-red-300 dark:focus:ring-red-800",
    pink: "text-white bg-gradient-to-r from-pink-400 via-pink-500 to-pink-600 hover:bg-gradient-to-br focus:ring-pink-300 dark:focus:ring-pink-800",
    purple: "text-white bg-gradient-to-r from-purple-500 via-purple-600 to-purple-700 hover:bg-gradient-to-br focus:ring-purple-300 dark:focus:ring-purple-800",
    purpleToBlue: "text-white bg-gradient-to-br from-purple-600 to-blue-500 hover:bg-gradient-to-bl focus:ring-blue-300 dark:focus:ring-blue-800",
    cyanToBlue: "text-white bg-gradient-to-r from-cyan-500 to-blue-500 hover:bg-gradient-to-bl focus:ring-cyan-300 dark:focus:ring-cyan-800",
    greenToBlue: "text-white bg-gradient-to-br from-green-400 to-blue-600 hover:bg-gradient-to-bl focus:ring-green-200 dark:focus:ring-green-800",
    purpleToPink: "text-white bg-gradient-to-r from-purple-500 to-pink-500 hover:bg-gradient-to-l focus:ring-purple-200 dark:focus:ring-purple-800",
    pinkToOrange: "text-white bg-gradient-to-br from-pink-500 to-orange-400 hover:bg-gradient-to-bl focus:ring-pink-200 dark:focus:ring-pink-800",
    tealToLime: "text-gray-900 bg-gradient-to-r from-teal-200 to-lime-200 hover:bg-gradient-to-l focus:ring-lime-200 dark:focus:ring-teal-700",
    redToYellow: "text-gray-900 bg-gradient-to-r from-red-200 via-red-300 to-yellow-200 hover:bg-gradient-to-bl focus:ring-red-100 dark:focus:ring-red-400"
  };
  const coloredShadowClasses = {
    blue: "shadow-blue-500/50 dark:shadow-blue-800/80",
    green: "shadow-green-500/50 dark:shadow-green-800/80",
    cyan: "shadow-cyan-500/50 dark:shadow-cyan-800/80",
    teal: "shadow-teal-500/50 dark:shadow-teal-800/80 ",
    lime: "shadow-lime-500/50 dark:shadow-lime-800/80",
    red: "shadow-red-500/50 dark:shadow-red-800/80 ",
    pink: "shadow-pink-500/50 dark:shadow-pink-800/80",
    purple: "shadow-purple-500/50 dark:shadow-purple-800/80",
    purpleToBlue: "shadow-blue-500/50 dark:shadow-blue-800/80",
    cyanToBlue: "shadow-cyan-500/50 dark:shadow-cyan-800/80",
    greenToBlue: "shadow-green-500/50 dark:shadow-green-800/80",
    purpleToPink: "shadow-purple-500/50 dark:shadow-purple-800/80",
    pinkToOrange: "shadow-pink-500/50 dark:shadow-pink-800/80",
    tealToLime: "shadow-lime-500/50 dark:shadow-teal-800/80",
    redToYellow: "shadow-red-500/50 dark:shadow-red-800/80"
  };
  let gradientOutlineClass;
  let divClass;
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  if ($$props.shadow === void 0 && $$bindings.shadow && shadow !== void 0)
    $$bindings.shadow(shadow);
  gradientOutlineClass = twMerge(
    "inline-flex items-center justify-center w-full  !border-0",
    $$props.pill || "!rounded-md",
    "bg-white !text-gray-900 dark:bg-gray-900 dark:!text-white",
    // this is limitation - no transparency
    "hover:bg-transparent hover:!text-inherit",
    "transition-all duration-75 ease-in group-hover:!bg-opacity-0 group-hover:!text-inherit"
  );
  divClass = twMerge(
    $$props.outline && "p-0.5",
    gradientClasses[color],
    shadow && "shadow-lg",
    shadow && coloredShadowClasses[color],
    group ? $$props.pill && "first:rounded-l-full last:rounded-r-full" || "first:rounded-l-lg last:rounded-r-lg" : $$props.pill && "rounded-full" || "rounded-lg",
    $$props.class
  );
  return `${$$props.outline ? `<div${add_attribute("class", divClass, 0)}> ${validate_component(Button, "Button").$$render($$result, Object.assign({}, $$restProps, { color: "none" }, { class: gradientOutlineClass }), {}, {
    default: () => {
      return `${slots.default ? slots.default({}) : ``}`;
    }
  })}</div>` : `${validate_component(Button, "Button").$$render($$result, Object.assign({}, $$restProps, { color: "none" }, { class: divClass }), {}, {
    default: () => {
      return `${slots.default ? slots.default({}) : ``}`;
    }
  })}`} `;
});
function createEventDispatcher() {
  const component = get_current_component();
  return (type, target, detail) => {
    const callbacks = component.$$.callbacks[type];
    if (callbacks) {
      const event = new CustomEvent(type, { detail });
      target.dispatchEvent(event);
      callbacks.slice().forEach((fn) => {
        fn.call(component, event);
      });
    }
  };
}
const Popper = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, [
    "activeContent",
    "arrow",
    "offset",
    "placement",
    "trigger",
    "triggeredBy",
    "reference",
    "strategy",
    "open",
    "yOnly"
  ]);
  let { activeContent = false } = $$props;
  let { arrow = true } = $$props;
  let { offset = 8 } = $$props;
  let { placement = "top" } = $$props;
  let { trigger = "hover" } = $$props;
  let { triggeredBy = void 0 } = $$props;
  let { reference = void 0 } = $$props;
  let { strategy = "absolute" } = $$props;
  let { open = false } = $$props;
  let { yOnly = false } = $$props;
  const dispatch = createEventDispatcher();
  let referenceEl;
  let floatingEl;
  let arrowEl;
  let contentEl;
  const px = (n2) => n2 != null ? `${n2}px` : "";
  let arrowSide;
  const oppositeSideMap = {
    left: "right",
    right: "left",
    bottom: "top",
    top: "bottom"
  };
  let middleware;
  function updatePosition() {
    dom.computePosition(referenceEl, floatingEl, { placement, strategy, middleware }).then(({ x, y, middlewareData, placement: placement2, strategy: strategy2 }) => {
      floatingEl.style.position = strategy2;
      floatingEl.style.left = yOnly ? "0" : px(x);
      floatingEl.style.top = px(y);
      if (middlewareData.arrow && arrowEl instanceof HTMLDivElement) {
        arrowEl.style.left = px(middlewareData.arrow.x);
        arrowEl.style.top = px(middlewareData.arrow.y);
        arrowSide = oppositeSideMap[placement2.split("-")[0]];
        arrowEl.style[arrowSide] = px(-arrowEl.offsetWidth / 2 - ($$props.border ? 1 : 0));
      }
    });
  }
  function init(node, _referenceEl) {
    floatingEl = node;
    let cleanup = dom.autoUpdate(_referenceEl, floatingEl, updatePosition);
    return {
      update(_referenceEl2) {
        cleanup();
        cleanup = dom.autoUpdate(_referenceEl2, floatingEl, updatePosition);
      },
      destroy() {
        cleanup();
      }
    };
  }
  let arrowClass;
  if ($$props.activeContent === void 0 && $$bindings.activeContent && activeContent !== void 0)
    $$bindings.activeContent(activeContent);
  if ($$props.arrow === void 0 && $$bindings.arrow && arrow !== void 0)
    $$bindings.arrow(arrow);
  if ($$props.offset === void 0 && $$bindings.offset && offset !== void 0)
    $$bindings.offset(offset);
  if ($$props.placement === void 0 && $$bindings.placement && placement !== void 0)
    $$bindings.placement(placement);
  if ($$props.trigger === void 0 && $$bindings.trigger && trigger !== void 0)
    $$bindings.trigger(trigger);
  if ($$props.triggeredBy === void 0 && $$bindings.triggeredBy && triggeredBy !== void 0)
    $$bindings.triggeredBy(triggeredBy);
  if ($$props.reference === void 0 && $$bindings.reference && reference !== void 0)
    $$bindings.reference(reference);
  if ($$props.strategy === void 0 && $$bindings.strategy && strategy !== void 0)
    $$bindings.strategy(strategy);
  if ($$props.open === void 0 && $$bindings.open && open !== void 0)
    $$bindings.open(open);
  if ($$props.yOnly === void 0 && $$bindings.yOnly && yOnly !== void 0)
    $$bindings.yOnly(yOnly);
  placement && (referenceEl = referenceEl);
  {
    dispatch("show", referenceEl, open);
  }
  middleware = [
    dom.flip(),
    dom.shift(),
    dom.offset(+offset),
    arrowEl
  ];
  arrowClass = twJoin("absolute pointer-events-none block w-[10px] h-[10px] rotate-45 bg-inherit border-inherit", $$props.border && arrowSide === "bottom" && "border-b border-r", $$props.border && arrowSide === "top" && "border-t border-l ", $$props.border && arrowSide === "right" && "border-t border-r ", $$props.border && arrowSide === "left" && "border-b border-l ");
  return `${!referenceEl ? `<div${add_attribute("this", contentEl, 0)}></div>` : ``} ${open && referenceEl ? `${validate_component(Frame, "Frame").$$render($$result, Object.assign({}, { use: init }, { options: referenceEl }, { role: "tooltip" }, { tabindex: activeContent ? -1 : void 0 }, $$restProps), {}, {
    default: () => {
      return `${slots.default ? slots.default({}) : ``} ${arrow ? `<div${add_attribute("class", arrowClass, 0)}></div>` : ``}`;
    }
  })}` : ``} `;
});
let n = Date.now();
function generateId() {
  return (++n).toString(36);
}
const Popover = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["title", "defaultClass"]);
  let $$slots = compute_slots(slots);
  let { title = "" } = $$props;
  let { defaultClass = "py-2 px-3" } = $$props;
  if ($$props.title === void 0 && $$bindings.title && title !== void 0)
    $$bindings.title(title);
  if ($$props.defaultClass === void 0 && $$bindings.defaultClass && defaultClass !== void 0)
    $$bindings.defaultClass(defaultClass);
  return `${validate_component(Popper, "Popper").$$render(
    $$result,
    Object.assign({}, { activeContent: true }, { border: true }, { shadow: true }, { rounded: true }, $$restProps, {
      class: "dark:!border-gray-600 " + $$props.class
    }),
    {},
    {
      default: () => {
        return `${$$slots.title || title ? `<div class="py-2 px-3 bg-gray-100 rounded-t-md border-b border-gray-200 dark:border-gray-600 dark:bg-gray-700">${slots.title ? slots.title({}) : ` <h3 class="font-semibold text-gray-900 dark:text-white">${escape(title)}</h3> `}</div>` : ``} <div${add_attribute("class", defaultClass, 0)}>${slots.default ? slots.default({}) : ``}</div>`;
      }
    }
  )} `;
});
const SpeedDial = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, [
    "defaultClass",
    "popperDefaultClass",
    "placement",
    "pill",
    "tooltip",
    "trigger",
    "textOutside",
    "id",
    "name",
    "gradient",
    "open"
  ]);
  let { defaultClass = "fixed right-6 bottom-6" } = $$props;
  let { popperDefaultClass = "flex items-center mb-4 gap-2" } = $$props;
  let { placement = "top" } = $$props;
  let { pill = true } = $$props;
  let { tooltip = "left" } = $$props;
  let { trigger = "hover" } = $$props;
  let { textOutside = false } = $$props;
  let { id = generateId() } = $$props;
  let { name = "Open actions menu" } = $$props;
  let { gradient = false } = $$props;
  let { open = false } = $$props;
  setContext("speed-dial", { pill, tooltip, textOutside });
  let divClass;
  let poperClass;
  if ($$props.defaultClass === void 0 && $$bindings.defaultClass && defaultClass !== void 0)
    $$bindings.defaultClass(defaultClass);
  if ($$props.popperDefaultClass === void 0 && $$bindings.popperDefaultClass && popperDefaultClass !== void 0)
    $$bindings.popperDefaultClass(popperDefaultClass);
  if ($$props.placement === void 0 && $$bindings.placement && placement !== void 0)
    $$bindings.placement(placement);
  if ($$props.pill === void 0 && $$bindings.pill && pill !== void 0)
    $$bindings.pill(pill);
  if ($$props.tooltip === void 0 && $$bindings.tooltip && tooltip !== void 0)
    $$bindings.tooltip(tooltip);
  if ($$props.trigger === void 0 && $$bindings.trigger && trigger !== void 0)
    $$bindings.trigger(trigger);
  if ($$props.textOutside === void 0 && $$bindings.textOutside && textOutside !== void 0)
    $$bindings.textOutside(textOutside);
  if ($$props.id === void 0 && $$bindings.id && id !== void 0)
    $$bindings.id(id);
  if ($$props.name === void 0 && $$bindings.name && name !== void 0)
    $$bindings.name(name);
  if ($$props.gradient === void 0 && $$bindings.gradient && gradient !== void 0)
    $$bindings.gradient(gradient);
  if ($$props.open === void 0 && $$bindings.open && open !== void 0)
    $$bindings.open(open);
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    divClass = twMerge(defaultClass, "group", $$props.class);
    poperClass = twMerge(popperDefaultClass, ["top", "bottom"].includes(placement.split("-")[0]) && "flex-col");
    $$rendered = `<div${add_attribute("class", divClass, 0)}>${gradient ? `${validate_component(GradientButton, "GradientButton").$$render($$result, Object.assign({}, { pill }, { name }, { "aria-controls": id }, { "aria-expanded": open }, $$restProps, { class: "!p-3" }), {}, {
      default: () => {
        return `${slots.icon ? slots.icon({}) : ` <svg aria-hidden="true" class="w-8 h-8 transition-transform group-hover:rotate-45" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg> `} <span class="sr-only">${escape(name)}</span>`;
      }
    })}` : `${validate_component(Button, "Button").$$render($$result, Object.assign({}, { pill }, { name }, { "aria-controls": id }, { "aria-expanded": open }, $$restProps, { class: "!p-3" }), {}, {
      default: () => {
        return `${slots.icon ? slots.icon({}) : ` <svg aria-hidden="true" class="w-8 h-8 transition-transform group-hover:rotate-45" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg> `} <span class="sr-only">${escape(name)}</span>`;
      }
    })}`} ${validate_component(Popper, "Popper").$$render(
      $$result,
      {
        id,
        trigger,
        arrow: false,
        color: "none",
        activeContent: true,
        placement,
        class: poperClass,
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
          return `${slots.default ? slots.default({}) : ``}`;
        }
      }
    )}</div> `;
  } while (!$$settled);
  return $$rendered;
});
const Tooltip = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["type", "defaultClass"]);
  let { type = "dark" } = $$props;
  let { defaultClass = "py-2 px-3 text-sm font-medium" } = $$props;
  const types = {
    dark: "bg-gray-900 text-white dark:bg-gray-700",
    light: "border-gray-200 bg-white text-gray-900",
    auto: " bg-white text-gray-900 dark:bg-gray-700 dark:text-white border-gray-200 dark:border-gray-700",
    custom: ""
  };
  let toolTipClass;
  if ($$props.type === void 0 && $$bindings.type && type !== void 0)
    $$bindings.type(type);
  if ($$props.defaultClass === void 0 && $$bindings.defaultClass && defaultClass !== void 0)
    $$bindings.defaultClass(defaultClass);
  {
    {
      if ($$restProps.color)
        type = "custom";
      else
        $$restProps.color = "none";
      if (["light", "auto"].includes(type))
        $$restProps.border = true;
      toolTipClass = twMerge("tooltip", defaultClass, types[type], $$props.class);
    }
  }
  return `${validate_component(Popper, "Popper").$$render($$result, Object.assign({}, { rounded: true }, { shadow: true }, $$restProps, { class: toolTipClass }), {}, {
    default: () => {
      return `${slots.default ? slots.default({}) : ``}`;
    }
  })} `;
});
const SpeedDialButton = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, [
    "btnDefaultClass",
    "name",
    "tooltip",
    "pill",
    "textOutside",
    "textOutsideClass",
    "textDefaultClass"
  ]);
  const context = getContext("speed-dial");
  let { btnDefaultClass = "w-[52px] h-[52px] shadow-sm !p-2" } = $$props;
  let { name = "" } = $$props;
  let { tooltip = context.tooltip } = $$props;
  let { pill = context.pill } = $$props;
  let { textOutside = context.textOutside } = $$props;
  let { textOutsideClass = "block absolute -left-14 top-1/2 mb-px text-sm font-medium -translate-y-1/2" } = $$props;
  let { textDefaultClass = "block mb-px text-xs font-medium" } = $$props;
  let btnClass;
  if ($$props.btnDefaultClass === void 0 && $$bindings.btnDefaultClass && btnDefaultClass !== void 0)
    $$bindings.btnDefaultClass(btnDefaultClass);
  if ($$props.name === void 0 && $$bindings.name && name !== void 0)
    $$bindings.name(name);
  if ($$props.tooltip === void 0 && $$bindings.tooltip && tooltip !== void 0)
    $$bindings.tooltip(tooltip);
  if ($$props.pill === void 0 && $$bindings.pill && pill !== void 0)
    $$bindings.pill(pill);
  if ($$props.textOutside === void 0 && $$bindings.textOutside && textOutside !== void 0)
    $$bindings.textOutside(textOutside);
  if ($$props.textOutsideClass === void 0 && $$bindings.textOutsideClass && textOutsideClass !== void 0)
    $$bindings.textOutsideClass(textOutsideClass);
  if ($$props.textDefaultClass === void 0 && $$bindings.textDefaultClass && textDefaultClass !== void 0)
    $$bindings.textDefaultClass(textDefaultClass);
  btnClass = twMerge(btnDefaultClass, tooltip === "none" && "flex-col", textOutside && "relative", $$props.class);
  return `${validate_component(Button, "Button").$$render($$result, Object.assign({}, { pill }, { outline: true }, { color: "light" }, $$restProps, { class: btnClass }), {}, {
    default: () => {
      return `${slots.default ? slots.default({}) : ``} ${tooltip !== "none" ? `<span class="sr-only">${escape(name)}</span>` : `${textOutside ? `<span${add_attribute("class", textOutsideClass, 0)}>${escape(name)}</span>` : `<span${add_attribute("class", textDefaultClass, 0)}>${escape(name)}</span>`}`}`;
    }
  })} ${tooltip !== "none" ? `${validate_component(Tooltip, "Tooltip").$$render($$result, { placement: tooltip, style: "dark" }, {}, {
    default: () => {
      return `${escape(name)}`;
    }
  })}` : ``} `;
});
const ArrowLeftOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "arrow left outline" } = $$props;
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
      { viewBox: "0 0 14 11" }
    ],
    {}
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M13 5.64H1m0 0 4 3.791m-4-3.79L5 1.85"></path></svg> `;
});
const ArrowRightOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "arrow right outline" } = $$props;
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
      { viewBox: "0 0 14 11" }
    ],
    {}
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M1 5.64h12m0 0L9 1.85m4 3.79L9 9.432"></path></svg> `;
});
const ChervonDoubleLeftSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "chervon double left solid" } = $$props;
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
      { viewBox: "0 0 12 10" }
    ],
    {}
  )}><g fill="currentColor"><path d="M4.995 10a1 1 0 0 1-.707-.293L.292 5.712a.999.999 0 0 1 0-1.412L4.288.305a1 1 0 1 1 1.413 1.412l-3.29 3.29 3.29 3.288A.999.999 0 0 1 4.995 10Z"></path><path d="M10.989 10a1 1 0 0 1-.707-.293L6.286 5.712a.999.999 0 0 1 0-1.412L10.282.305a1 1 0 1 1 1.413 1.412l-3.29 3.29 3.29 3.288A.998.998 0 0 1 10.989 10Z"></path></g></svg> `;
});
const ChervonDoubleRightSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "chervon double right solid" } = $$props;
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
      { viewBox: "0 0 12 10" }
    ],
    {}
  )}><g fill="currentColor"><path d="M7.005 10A1 1 0 0 1 6.3 8.295l3.29-3.289L6.3 1.717A.999.999 0 1 1 7.712.305L11.707 4.3a.999.999 0 0 1 0 1.412L7.712 9.707a1 1 0 0 1-.707.293Z"></path><path d="M1.011 10a1 1 0 0 1-.706-1.705l3.29-3.289-3.29-3.289A.999.999 0 1 1 1.718.305L5.714 4.3a.999.999 0 0 1 0 1.412L1.718 9.707A1 1 0 0 1 1.01 10Z"></path></g></svg> `;
});
const ChevronLeftSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "chevron left solid" } = $$props;
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
      { viewBox: "0 0 6 10" }
    ],
    {}
  )}><path fill="currentColor" d="M4.99 10a.998.998 0 0 1-.706-.293L.292 5.712a1 1 0 0 1 0-1.412L4.284.305a.998.998 0 1 1 1.411 1.412L2.41 5.007l3.286 3.288A.999.999 0 0 1 4.99 10Z"></path></svg> `;
});
const ChevronRightSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "chevron right solid" } = $$props;
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
      { viewBox: "0 0 6 10" }
    ],
    {}
  )}><path fill="currentColor" d="M1.01 10a.997.997 0 0 1-.705-1.705L3.59 5.006.305 1.717A.999.999 0 1 1 1.715.305L5.709 4.3a1 1 0 0 1 0 1.412L1.716 9.707A.998.998 0 0 1 1.01 10Z"></path></svg> `;
});
const CompressOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "compress outline" } = $$props;
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
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M13 16.922V13.13h4M1 5.549h4v-3.79M1 13.13h4v3.79m8-15.163V5.55h4"></path></svg> `;
});
const ImageOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "image outline" } = $$props;
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
      { viewBox: "0 0 20 18" }
    ],
    {}
  )}><path fill="currentColor" d="M13 5.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0ZM7.565 7.423 4.5 14h11.518l-2.516-3.71L11 13 7.565 7.423Z"></path><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M18 1H2a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1Z"></path><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"${add_attribute("stroke-width", strokeWidth, 0)} d="M13 5.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0ZM7.565 7.423 4.5 14h11.518l-2.516-3.71L11 13 7.565 7.423Z"></path></svg> `;
});
const ZoomOutOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "zoom out outline" } = $$props;
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
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="m19 19-4-4M5 8h6m4 0A7 7 0 1 1 1 8a7 7 0 0 1 14 0Z"></path></svg> `;
});
const panzoomStore = writable(void 0);
function zoomDefault() {
  const zoomDefault2 = get_store_value(settings).zoomDefault;
  switch (zoomDefault2) {
    case "zoomFitToScreen":
      return;
    case "zoomFitToWidth":
      return;
    case "zoomOriginal":
      return;
    case "keepZoomStart":
      return;
  }
}
const Panzoom = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  return `<div>${slots.default ? slots.default({}) : ``}</div>`;
});
const cropperStore = writable(void 0);
const TextBoxes_svelte_svelte_type_style_lang = "";
const css$1 = {
  code: ".textBox.svelte-11qvai3.svelte-11qvai3{color:black;padding:0;position:absolute;line-height:1.1em;font-size:16pt;white-space:nowrap;border:1px solid rgba(0, 0, 0, 0);z-index:11}.textBox.svelte-11qvai3.svelte-11qvai3:focus,.textBox.svelte-11qvai3.svelte-11qvai3:hover{background:rgb(255, 255, 255);border:1px solid rgba(0, 0, 0, 0)}.textBox.svelte-11qvai3 p.svelte-11qvai3{display:none;white-space:nowrap;letter-spacing:0.1em;line-height:1.1em;margin:0;background-color:rgb(255, 255, 255);font-weight:var(--bold);z-index:11}.textBox.svelte-11qvai3:focus p.svelte-11qvai3,.textBox.svelte-11qvai3:hover p.svelte-11qvai3{display:table}",
  map: null
};
const TextBoxes = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let textBoxes;
  let fontWeight;
  let display;
  let border;
  let contenteditable;
  let $settings, $$unsubscribe_settings;
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  let { page: page2 } = $$props;
  let { src } = $$props;
  if ($$props.page === void 0 && $$bindings.page && page2 !== void 0)
    $$bindings.page(page2);
  if ($$props.src === void 0 && $$bindings.src && src !== void 0)
    $$bindings.src(src);
  $$result.css.add(css$1);
  textBoxes = page2.blocks.map((block) => {
    const { img_height, img_width } = page2;
    const { box, font_size, lines, vertical } = block;
    let [_xmin, _ymin, _xmax, _ymax] = box;
    const xmin = clamp(_xmin, 0, img_width);
    const ymin = clamp(_ymin, 0, img_height);
    const xmax = clamp(_xmax, 0, img_width);
    const ymax = clamp(_ymax, 0, img_height);
    const width = xmax - xmin;
    const height = ymax - ymin;
    const area = width * height;
    const textBox = {
      left: `${xmin}px`,
      top: `${ymin}px`,
      width: `${width}px`,
      height: `${height}px`,
      fontSize: $settings.fontSize === "auto" ? `${font_size}px` : `${$settings.fontSize}pt`,
      writingMode: vertical ? "vertical-rl" : "horizontal-tb",
      lines,
      area
    };
    return textBox;
  }).sort(({ area: a }, { area: b }) => {
    return b - a;
  });
  fontWeight = $settings.boldFont ? "bold" : "400";
  display = $settings.displayOCR ? "block" : "none";
  border = $settings.textBoxBorders ? "1px solid red" : "none";
  contenteditable = $settings.textEditable;
  $settings.ankiConnectSettings.triggerMethod || "both";
  $$unsubscribe_settings();
  return `${each(textBoxes, ({ fontSize, height, left, lines, top, width, writingMode }, index) => {
    return `<div class="textBox svelte-11qvai3" role="none"${add_attribute("contenteditable", contenteditable, 0)}${add_styles({
      width,
      height,
      left,
      top,
      "font-size": fontSize,
      "font-weight": fontWeight,
      display,
      border,
      "writing-mode": writingMode
    })}>${each(lines, (line) => {
      return `<p class="svelte-11qvai3">${escape(line)}</p>`;
    })} </div>`;
  })}`;
});
const MangaPage = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let url;
  let { page: page2 } = $$props;
  let { src } = $$props;
  if ($$props.page === void 0 && $$bindings.page && page2 !== void 0)
    $$bindings.page(page2);
  if ($$props.src === void 0 && $$bindings.src && src !== void 0)
    $$bindings.src(src);
  url = src ? `url(${URL.createObjectURL(src)})` : "";
  return `<div draggable="false" class="relative"${add_styles({
    "width": `${page2.img_width}px`,
    "height": `${page2.img_height}px`,
    "background-image": url
  })}>${validate_component(TextBoxes, "TextBoxes").$$render($$result, { page: page2, src }, {}, {})}</div>`;
});
function restrictPosition(position, imageSize, cropSize, zoom) {
  return {
    x: restrictPositionCoord(position.x, imageSize.width, cropSize.width, zoom),
    y: restrictPositionCoord(position.y, imageSize.height, cropSize.height, zoom)
  };
}
function restrictPositionCoord(position, imageSize, cropSize, zoom) {
  const maxPosition = imageSize * zoom / 2 - cropSize / 2;
  return Math.min(maxPosition, Math.max(position, -maxPosition));
}
function getDistanceBetweenPoints(pointA, pointB) {
  return Math.sqrt(Math.pow(pointA.y - pointB.y, 2) + Math.pow(pointA.x - pointB.x, 2));
}
function getCenter(a, b) {
  return {
    x: (b.x + a.x) / 2,
    y: (b.y + a.y) / 2
  };
}
const Cropper_svelte_svelte_type_style_lang = "";
const css = {
  code: ".container.svelte-12kodkg{position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;user-select:none;touch-action:none;cursor:move}.image.svelte-12kodkg{max-width:100%;max-height:100%;margin:auto;position:absolute;top:0;bottom:0;left:0;right:0;will-change:transform}.cropperArea.svelte-12kodkg{position:absolute;left:50%;top:50%;transform:translate(-50%, -50%);box-shadow:0 0 0 9999em;box-sizing:border-box;color:rgba(0, 0, 0, 0.5);border:1px solid rgba(255, 255, 255, 0.5);overflow:hidden}.grid.svelte-12kodkg:before{content:' ';box-sizing:border-box;border:1px solid rgba(255, 255, 255, 0.5);position:absolute;top:0;bottom:0;left:33.33%;right:33.33%;border-top:0;border-bottom:0}.grid.svelte-12kodkg:after{content:' ';box-sizing:border-box;border:1px solid rgba(255, 255, 255, 0.5);position:absolute;top:33.33%;bottom:33.33%;left:0;right:0;border-left:0;border-right:0}.round.svelte-12kodkg{border-radius:50%}",
  map: null
};
const Cropper = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let { image } = $$props;
  let { crop = { x: 0, y: 0 } } = $$props;
  let { zoom = 1 } = $$props;
  let { aspect = 4 / 3 } = $$props;
  let { minZoom = 1 } = $$props;
  let { maxZoom = 3 } = $$props;
  let { cropSize = null } = $$props;
  let { cropShape = "rect" } = $$props;
  let { showGrid = true } = $$props;
  let { zoomSpeed = 1 } = $$props;
  let { crossOrigin = null } = $$props;
  let { restrictPosition: restrictPosition$1 = true } = $$props;
  let cropperSize = null;
  let imageSize = {
    width: 0,
    height: 0,
    naturalWidth: 0,
    naturalHeight: 0
  };
  let containerEl = null;
  let imgEl = null;
  let dragStartPosition = { x: 0, y: 0 };
  let dragStartCrop = { x: 0, y: 0 };
  let rafDragTimeout = null;
  let rafZoomTimeout = null;
  createEventDispatcher$1();
  onDestroy(() => {
    cleanEvents();
  });
  const cleanEvents = () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onDragStopped);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onDragStopped);
    }
  };
  const getMousePoint = (e) => ({
    x: Number(e.clientX),
    y: Number(e.clientY)
  });
  const getTouchPoint = (touch) => ({
    x: Number(touch.clientX),
    y: Number(touch.clientY)
  });
  const onMouseMove = (e) => onDrag(getMousePoint(e));
  const onTouchMove = (e) => {
    e.preventDefault();
    if (e.touches.length === 2) {
      onPinchMove(e);
    } else if (e.touches.length === 1) {
      onDrag(getTouchPoint(e.touches[0]));
    }
  };
  const onDrag = ({ x, y }) => {
    if (rafDragTimeout)
      window.cancelAnimationFrame(rafDragTimeout);
    rafDragTimeout = window.requestAnimationFrame(() => {
      if (x === void 0 || y === void 0 || !cropperSize)
        return;
      const offsetX = x - dragStartPosition.x;
      const offsetY = y - dragStartPosition.y;
      const requestedPosition = {
        x: dragStartCrop.x + offsetX,
        y: dragStartCrop.y + offsetY
      };
      crop = restrictPosition$1 ? restrictPosition(requestedPosition, imageSize, cropperSize, zoom) : requestedPosition;
    });
  };
  const onDragStopped = () => {
    cleanEvents();
  };
  const onPinchMove = (e) => {
    const pointA = getTouchPoint(e.touches[0]);
    const pointB = getTouchPoint(e.touches[1]);
    const center = getCenter(pointA, pointB);
    onDrag(center);
    if (rafZoomTimeout)
      window.cancelAnimationFrame(rafZoomTimeout);
    rafZoomTimeout = window.requestAnimationFrame(() => {
      getDistanceBetweenPoints(pointA, pointB);
    });
  };
  if ($$props.image === void 0 && $$bindings.image && image !== void 0)
    $$bindings.image(image);
  if ($$props.crop === void 0 && $$bindings.crop && crop !== void 0)
    $$bindings.crop(crop);
  if ($$props.zoom === void 0 && $$bindings.zoom && zoom !== void 0)
    $$bindings.zoom(zoom);
  if ($$props.aspect === void 0 && $$bindings.aspect && aspect !== void 0)
    $$bindings.aspect(aspect);
  if ($$props.minZoom === void 0 && $$bindings.minZoom && minZoom !== void 0)
    $$bindings.minZoom(minZoom);
  if ($$props.maxZoom === void 0 && $$bindings.maxZoom && maxZoom !== void 0)
    $$bindings.maxZoom(maxZoom);
  if ($$props.cropSize === void 0 && $$bindings.cropSize && cropSize !== void 0)
    $$bindings.cropSize(cropSize);
  if ($$props.cropShape === void 0 && $$bindings.cropShape && cropShape !== void 0)
    $$bindings.cropShape(cropShape);
  if ($$props.showGrid === void 0 && $$bindings.showGrid && showGrid !== void 0)
    $$bindings.showGrid(showGrid);
  if ($$props.zoomSpeed === void 0 && $$bindings.zoomSpeed && zoomSpeed !== void 0)
    $$bindings.zoomSpeed(zoomSpeed);
  if ($$props.crossOrigin === void 0 && $$bindings.crossOrigin && crossOrigin !== void 0)
    $$bindings.crossOrigin(crossOrigin);
  if ($$props.restrictPosition === void 0 && $$bindings.restrictPosition && restrictPosition$1 !== void 0)
    $$bindings.restrictPosition(restrictPosition$1);
  $$result.css.add(css);
  return ` <div class="container svelte-12kodkg" data-testid="container"${add_attribute("this", containerEl, 0)}><img class="image svelte-12kodkg"${add_attribute("src", image, 0)} alt="" style="${"transform: translate(" + escape(crop.x, true) + "px, " + escape(crop.y, true) + "px) scale(" + escape(zoom, true) + ");"}"${add_attribute("crossorigin", crossOrigin, 0)}${add_attribute("this", imgEl, 0)}> ${``} </div>`;
});
const Cropper_1 = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $cropperStore, $$unsubscribe_cropperStore;
  let $settings, $$unsubscribe_settings;
  $$unsubscribe_cropperStore = subscribe(cropperStore, (value) => $cropperStore = value);
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  let open = false;
  let loading = false;
  afterNavigate(() => {
    close();
  });
  beforeNavigate((nav) => {
    if (open) {
      nav.cancel();
      close();
    }
  });
  function close() {
    loading = false;
    cropperStore.set({ open: false });
  }
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    $$rendered = `${validate_component(Modal, "Modal").$$render(
      $$result,
      { title: "Crop image", open },
      {
        open: ($$value) => {
          open = $$value;
          $$settled = false;
        }
      },
      {
        default: () => {
          return `${$cropperStore?.image && !loading ? `<div class="flex flex-col gap-2"><div class="relative w-full h-[55svh] sm:h-[65svh]">${validate_component(Cropper, "Cropper").$$render(
            $$result,
            {
              zoomSpeed: 0.5,
              maxZoom: 10,
              image: $cropperStore?.image
            },
            {},
            {}
          )}</div> ${$settings.ankiConnectSettings.grabSentence && $cropperStore?.sentence ? `<p><b data-svelte-h="svelte-1rospi9">Sentence:</b> ${escape($cropperStore?.sentence)}</p>` : ``} ${validate_component(Button, "Button").$$render($$result, {}, {}, {
            default: () => {
              return `Crop`;
            }
          })} ${validate_component(Button, "Button").$$render($$result, { outline: true, color: "light" }, {}, {
            default: () => {
              return `Close`;
            }
          })}</div>` : `<div class="text-center">${validate_component(Spinner, "Spinner").$$render($$result, {}, {}, {})}</div>`}`;
        }
      }
    )}`;
  } while (!$$settled);
  $$unsubscribe_cropperStore();
  $$unsubscribe_settings();
  return $$rendered;
});
const SettingsButton = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let settingsHidden = true;
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    $$rendered = `<button class="hover:text-primary-700 hover:mix-blend-normal mix-blend-difference z-10 fixed opacity-50 hover:opacity-100 right-10 top-5 p-10 m-[-2.5rem]">${validate_component(UserSettingsSolid, "UserSettingsSolid").$$render($$result, {}, {}, {})}</button> ${validate_component(Settings, "Settings").$$render(
      $$result,
      { hidden: settingsHidden },
      {
        hidden: ($$value) => {
          settingsHidden = $$value;
          $$settled = false;
        }
      },
      {}
    )}`;
  } while (!$$settled);
  return $$rendered;
});
/**
 * @license BSD-3-Clause
 * Copyright (c) 2023, ッツ Reader Authors
 * All rights reserved.
 */
function countChars(line) {
  const japaneseRegex = /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  return Array.from(line).filter((char) => japaneseRegex.test(char)).length;
}
function getCharCount(pages, currentPage) {
  let charCount = 0;
  let lineCount = 0;
  if (pages && pages.length > 0) {
    const max = currentPage || pages.length;
    for (let i = 0; i < max; i++) {
      const blocks = pages[i].blocks;
      blocks.forEach((block) => {
        lineCount += block.lines.length;
        block.lines.forEach((line) => {
          charCount += countChars(line);
        });
      });
    }
  }
  return { charCount, lineCount };
}
const QuickActions = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $settings, $$unsubscribe_settings;
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  let { left } = $$props;
  let { right } = $$props;
  let { src1 } = $$props;
  let { src2 } = $$props;
  let open = false;
  if ($$props.left === void 0 && $$bindings.left && left !== void 0)
    $$bindings.left(left);
  if ($$props.right === void 0 && $$bindings.right && right !== void 0)
    $$bindings.right(right);
  if ($$props.src1 === void 0 && $$bindings.src1 && src1 !== void 0)
    $$bindings.src1(src1);
  if ($$props.src2 === void 0 && $$bindings.src2 && src2 !== void 0)
    $$bindings.src2(src2);
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    $$rendered = `${$settings.quickActions ? `${validate_component(SpeedDial, "SpeedDial").$$render(
      $$result,
      {
        tooltip: "none",
        trigger: "click",
        defaultClass: "absolute end-3 bottom-3 z-50",
        color: "transparent",
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
          return `${$settings.ankiConnectSettings.enabled ? `${validate_component(SpeedDialButton, "SpeedDialButton").$$render($$result, { name: src2 ? "1" : void 0 }, {}, {
            default: () => {
              return `${validate_component(ImageOutline, "ImageOutline").$$render($$result, {}, {}, {})}`;
            }
          })}` : ``} ${$settings.ankiConnectSettings.enabled && src2 ? `${validate_component(SpeedDialButton, "SpeedDialButton").$$render($$result, { name: "2" }, {}, {
            default: () => {
              return `${validate_component(ImageOutline, "ImageOutline").$$render($$result, {}, {}, {})}`;
            }
          })}` : ``} ${validate_component(SpeedDialButton, "SpeedDialButton").$$render($$result, {}, {}, {
            default: () => {
              return `${validate_component(CompressOutline, "CompressOutline").$$render($$result, {}, {}, {})}`;
            }
          })} ${validate_component(SpeedDialButton, "SpeedDialButton").$$render($$result, {}, {}, {
            default: () => {
              return `${validate_component(ZoomOutOutline, "ZoomOutOutline").$$render($$result, {}, {}, {})}`;
            }
          })} ${validate_component(SpeedDialButton, "SpeedDialButton").$$render($$result, {}, {}, {
            default: () => {
              return `${validate_component(ArrowRightOutline, "ArrowRightOutline").$$render($$result, {}, {}, {})}`;
            }
          })} ${validate_component(SpeedDialButton, "SpeedDialButton").$$render($$result, {}, {}, {
            default: () => {
              return `${validate_component(ArrowLeftOutline, "ArrowLeftOutline").$$render($$result, {}, {}, {})}`;
            }
          })}`;
        }
      }
    )}` : ``}`;
  } while (!$$settled);
  $$unsubscribe_settings();
  return $$rendered;
});
const Reader = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let volume;
  let volumeData;
  let pages;
  let page2;
  let index;
  let navAmount;
  let showSecondPage;
  let manualPage;
  let pageDisplay;
  let charDisplay;
  let charCount;
  let maxCharCount;
  let totalLineCount;
  let $settings, $$unsubscribe_settings;
  let $$unsubscribe_panzoomStore;
  let $currentSeries, $$unsubscribe_currentSeries;
  let $progress, $$unsubscribe_progress;
  let $currentVolumeData, $$unsubscribe_currentVolumeData;
  let $currentVolume, $$unsubscribe_currentVolume;
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  $$unsubscribe_panzoomStore = subscribe(panzoomStore, (value) => value);
  $$unsubscribe_currentSeries = subscribe(currentSeries, (value) => $currentSeries = value);
  $$unsubscribe_progress = subscribe(progress, (value) => $progress = value);
  $$unsubscribe_currentVolumeData = subscribe(currentVolumeData, (value) => $currentVolumeData = value);
  $$unsubscribe_currentVolume = subscribe(currentVolume, (value) => $currentVolume = value);
  let { volumeSettings: volumeSettings2 } = $$props;
  let start;
  function left(_e, ingoreTimeOut) {
    const newPage = volumeSettings2.rightToLeft ? page2 + navAmount : page2 - navAmount;
    changePage(newPage, ingoreTimeOut);
  }
  function right(_e, ingoreTimeOut) {
    const newPage = volumeSettings2.rightToLeft ? page2 - navAmount : page2 + navAmount;
    changePage(newPage, ingoreTimeOut);
  }
  function changePage(newPage, ingoreTimeOut = false) {
    const end = /* @__PURE__ */ new Date();
    const clickDuration = ingoreTimeOut ? 0 : end.getTime() - start?.getTime();
    if (pages && volume && (ingoreTimeOut || clickDuration < 200)) {
      if (showSecondPage() && page2 >= pages.length && newPage > page2) {
        return;
      }
      const pageClamped = clamp(newPage, 1, pages?.length);
      const { charCount: charCount2 } = getCharCount(pages, pageClamped);
      if (pageClamped !== newPage) {
        let seriesVolumes = $currentSeries;
        const currentVolumeIndex = seriesVolumes.findIndex((v) => v.volume_uuid === volume.volume_uuid);
        if (newPage < 1) {
          const previousVolume = seriesVolumes[currentVolumeIndex - 1];
          if (previousVolume)
            window.location.href = `/${volume.series_uuid}/${previousVolume.volume_uuid}`;
          else
            window.location.href = `/${volume.series_uuid}`;
        } else if (newPage > pages.length) {
          const nextVolume = seriesVolumes[currentVolumeIndex + 1];
          if (nextVolume)
            window.location.href = `/${volume.series_uuid}/${nextVolume.volume_uuid}`;
          else
            window.location.href = `/${volume.series_uuid}`;
        }
      } else {
        updateProgress(volume.volume_uuid, pageClamped, charCount2, pageClamped === pages.length || pageClamped === pages.length - 1);
        zoomDefault();
      }
    }
  }
  beforeNavigate(() => {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    }
    if (volume) {
      const { charCount: charCount2, lineCount } = getCharCount(pages, page2);
      fireExstaticEvent("mokuro-reader:reader.closed", {
        title: volume.series_title,
        volumeName: volume.volume_title,
        currentCharCount: charCount2,
        currentPage: page2,
        totalPages: pages.length,
        totalCharCount: maxCharCount || 0,
        currentLineCount: lineCount,
        totalLineCount
      });
    }
  });
  if ($$props.volumeSettings === void 0 && $$bindings.volumeSettings && volumeSettings2 !== void 0)
    $$bindings.volumeSettings(volumeSettings2);
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    volume = $currentVolume;
    volumeData = $currentVolumeData;
    pages = volumeData?.pages || [];
    page2 = $progress?.[volume?.volume_uuid || 0] || 1;
    index = page2 - 1;
    navAmount = volumeSettings2.singlePageView || volumeSettings2.hasCover && !volumeSettings2.singlePageView && index === 0 ? 1 : 2;
    showSecondPage = () => {
      if (!pages) {
        return false;
      }
      if (volumeSettings2.singlePageView || index + 1 >= pages.length) {
        return false;
      }
      if (index === 0 && volumeSettings2.hasCover) {
        return false;
      }
      return true;
    };
    manualPage = page2;
    pageDisplay = showSecondPage() ? `${page2},${page2 + 1} / ${pages?.length}` : `${page2} / ${pages?.length}`;
    charCount = $settings.charCount ? getCharCount(pages, page2).charCount : 0;
    maxCharCount = getCharCount(pages).charCount;
    charDisplay = `${charCount} / ${maxCharCount}`;
    totalLineCount = getCharCount(pages).lineCount;
    {
      {
        if (volume) {
          const { charCount: charCount2, lineCount } = getCharCount(pages, page2);
          fireExstaticEvent("mokuro-reader:page.change", {
            title: volume.series_title,
            volumeName: volume.volume_title,
            currentCharCount: charCount2,
            currentPage: page2,
            totalPages: pages.length,
            totalCharCount: maxCharCount || 0,
            currentLineCount: lineCount,
            totalLineCount
          });
        }
      }
    }
    $$rendered = ` ${$$result.head += `<!-- HEAD_svelte-fqypcp_START -->${$$result.title = `<title>${escape(volume?.volume_title || "Volume")}</title>`, ""}<!-- HEAD_svelte-fqypcp_END -->`, ""} ${volume && pages && volumeData ? `${validate_component(QuickActions, "QuickActions").$$render(
      $$result,
      {
        left,
        right,
        src1: Object.values(volumeData.files)[index],
        src2: !volumeSettings2.singlePageView ? Object.values(volumeData.files)[index + 1] : void 0
      },
      {},
      {}
    )} ${validate_component(SettingsButton, "SettingsButton").$$render($$result, {}, {}, {})} ${validate_component(Cropper_1, "Cropper").$$render($$result, {}, {}, {})} ${validate_component(Popover, "Popover").$$render(
      $$result,
      {
        placement: "bottom",
        trigger: "click",
        triggeredBy: "#page-num",
        class: "z-20 w-full max-w-xs"
      },
      {},
      {
        default: () => {
          return `<div class="flex flex-col gap-3"><div class="flex flex-row items-center gap-5 z-10">${validate_component(ChervonDoubleLeftSolid, "ChervonDoubleLeftSolid").$$render(
            $$result,
            {
              class: "hover:text-primary-600",
              size: "sm"
            },
            {},
            {}
          )} ${validate_component(ChevronLeftSolid, "ChevronLeftSolid").$$render(
            $$result,
            {
              class: "hover:text-primary-600",
              size: "sm"
            },
            {},
            {}
          )} ${validate_component(Input, "Input").$$render(
            $$result,
            {
              type: "number",
              size: "sm",
              value: manualPage
            },
            {
              value: ($$value) => {
                manualPage = $$value;
                $$settled = false;
              }
            },
            {}
          )} ${validate_component(ChevronRightSolid, "ChevronRightSolid").$$render(
            $$result,
            {
              class: "hover:text-primary-600",
              size: "sm"
            },
            {},
            {}
          )} ${validate_component(ChervonDoubleRightSolid, "ChervonDoubleRightSolid").$$render(
            $$result,
            {
              class: "hover:text-primary-600",
              size: "sm"
            },
            {},
            {}
          )}</div> <div${add_styles({
            "direction": volumeSettings2.rightToLeft ? "rtl" : "ltr"
          })}>${validate_component(Range, "Range").$$render(
            $$result,
            {
              min: 1,
              max: pages.length,
              defaultClass: "",
              value: manualPage
            },
            {
              value: ($$value) => {
                manualPage = $$value;
                $$settled = false;
              }
            },
            {}
          )}</div></div>`;
        }
      }
    )} <button class="absolute opacity-50 left-5 top-5 z-10 mix-blend-difference" id="page-num"><p class="${["text-left", !$settings.charCount ? "hidden" : ""].join(" ").trim()}">${escape(charDisplay)}</p> <p class="${["text-left", !$settings.pageNum ? "hidden" : ""].join(" ").trim()}">${escape(pageDisplay)}</p></button> <div class="flex"${add_styles({
      "background-color": $settings.backgroundColor
    })}>${validate_component(Panzoom, "Panzoom").$$render($$result, {}, {}, {
      default: () => {
        return `<button class="h-full fixed -left-full z-10 w-full hover:bg-slate-400 opacity-[0.01]"${add_styles({
          "margin-left": `${$settings.edgeButtonWidth}px`
        })}></button> <button class="h-full fixed -right-full z-10 w-full hover:bg-slate-400 opacity-[0.01]"${add_styles({
          "margin-right": `${$settings.edgeButtonWidth}px`
        })}></button> <button class="h-screen fixed top-full -left-full z-10 w-[150%] hover:bg-slate-400 opacity-[0.01]"></button> <button class="h-screen fixed top-full -right-full z-10 w-[150%] hover:bg-slate-400 opacity-[0.01]"></button> <div class="${["flex flex-row", !volumeSettings2.rightToLeft ? "flex-row-reverse" : ""].join(" ").trim()}" role="none" id="manga-panel"${add_styles({
          "filter": `invert(${$settings.invertColors ? 1 : 0})`
        })}>${showSecondPage() ? `${validate_component(MangaPage, "MangaPage").$$render(
          $$result,
          {
            page: pages[index + 1],
            src: Object.values(volumeData.files)[index + 1]
          },
          {},
          {}
        )}` : ``} ${validate_component(MangaPage, "MangaPage").$$render(
          $$result,
          {
            page: pages[index],
            src: Object.values(volumeData.files)[index]
          },
          {},
          {}
        )}</div>`;
      }
    })}</div> ${!$settings.mobile ? `<button class="left-0 top-0 absolute h-full w-16 hover:bg-slate-400 opacity-[0.01]"${add_styles({
      "width": `${$settings.edgeButtonWidth}px`
    })}></button> <button class="right-0 top-0 absolute h-full w-16 hover:bg-slate-400 opacity-[0.01]"${add_styles({
      "width": `${$settings.edgeButtonWidth}px`
    })}></button>` : ``}` : `<div class="fixed z-50 left-1/2 top-1/2">${validate_component(Spinner, "Spinner").$$render($$result, {}, {}, {})}</div>`}`;
  } while (!$$settled);
  $$unsubscribe_settings();
  $$unsubscribe_panzoomStore();
  $$unsubscribe_currentSeries();
  $$unsubscribe_progress();
  $$unsubscribe_currentVolumeData();
  $$unsubscribe_currentVolume();
  return $$rendered;
});
const Timer = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let active;
  let $volumeStats, $$unsubscribe_volumeStats;
  $$unsubscribe_volumeStats = subscribe(volumeStats, (value) => $volumeStats = value);
  let { count } = $$props;
  let { volumeId } = $$props;
  if ($$props.count === void 0 && $$bindings.count && count !== void 0)
    $$bindings.count(count);
  if ($$props.volumeId === void 0 && $$bindings.volumeId && volumeId !== void 0)
    $$bindings.volumeId(volumeId);
  active = Boolean(count);
  $$unsubscribe_volumeStats();
  return `<button class="${[
    "mix-blend-difference z-10 fixed opacity-50 right-20 top-5 p-10 m-[-2.5rem]",
    !active ? "text-primary-700" : ""
  ].join(" ").trim()}"><p>${escape(active ? "Active" : "Paused")} | Minutes read: ${escape($volumeStats?.timeReadInMinutes)}</p></button>`;
});
const Page = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let volumeId;
  let $$unsubscribe_volumes;
  let $page, $$unsubscribe_page;
  let $volumeSettings, $$unsubscribe_volumeSettings;
  let $settings, $$unsubscribe_settings;
  $$unsubscribe_volumes = subscribe(volumes, (value) => value);
  $$unsubscribe_page = subscribe(page, (value) => $page = value);
  $$unsubscribe_volumeSettings = subscribe(volumeSettings, (value) => $volumeSettings = value);
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  let count = void 0;
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    volumeId = $page.params.volume;
    $$rendered = `${$volumeSettings[volumeId] ? `${$settings.showTimer ? `${validate_component(Timer, "Timer").$$render(
      $$result,
      { volumeId, count },
      {
        count: ($$value) => {
          count = $$value;
          $$settled = false;
        }
      },
      {}
    )}` : ``} ${validate_component(Reader, "Reader").$$render(
      $$result,
      {
        volumeSettings: $volumeSettings[volumeId]
      },
      {},
      {}
    )}` : ``}`;
  } while (!$$settled);
  $$unsubscribe_volumes();
  $$unsubscribe_page();
  $$unsubscribe_volumeSettings();
  $$unsubscribe_settings();
  return $$rendered;
});
export {
  Page as default
};
