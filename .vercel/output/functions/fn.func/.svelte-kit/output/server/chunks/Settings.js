import { c as create_ssr_component, a as compute_rest_props, s as setContext, v as validate_component, u as identity, o as getContext, k as subscribe, b as add_attribute, d as spread, f as escape_attribute_value, e as escape_object, g as escape, h as createEventDispatcher, i as compute_slots, l as each, q as get_store_value } from "./ssr.js";
import { w as writable } from "./index.js";
import { F as Frame, a as Listgroup, L as ListgroupItem } from "./Listgroup.js";
import { twMerge } from "tailwind-merge";
import { s as settings, i as profiles, j as currentProfile, B as Button, t as totalStats, a as volumes, h as volumeSettings } from "./misc.js";
import "./db.js";
import { p as page } from "./stores.js";
import "@zip.js/zip.js";
import { I as Input } from "./Input.js";
import { T as TrashBinSolid } from "./TrashBinSolid.js";
import "panzoom";
const Accordion = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["multiple", "flush", "activeClass", "inactiveClass", "defaultClass"]);
  let { multiple = false } = $$props;
  let { flush = false } = $$props;
  let { activeClass = "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-4 focus:ring-gray-200 dark:focus:ring-gray-800" } = $$props;
  let { inactiveClass = "text-gray-500 dark:text-gray-400 hover:bg-gray-100 hover:dark:bg-gray-800" } = $$props;
  let { defaultClass = "text-gray-500 dark:text-gray-400" } = $$props;
  const ctx = {
    flush,
    activeClass: twMerge(activeClass, $$props.classActive),
    inactiveClass: twMerge(inactiveClass, $$props.classInactive),
    selected: multiple ? void 0 : writable()
  };
  setContext("ctx", ctx);
  let frameClass;
  if ($$props.multiple === void 0 && $$bindings.multiple && multiple !== void 0)
    $$bindings.multiple(multiple);
  if ($$props.flush === void 0 && $$bindings.flush && flush !== void 0)
    $$bindings.flush(flush);
  if ($$props.activeClass === void 0 && $$bindings.activeClass && activeClass !== void 0)
    $$bindings.activeClass(activeClass);
  if ($$props.inactiveClass === void 0 && $$bindings.inactiveClass && inactiveClass !== void 0)
    $$bindings.inactiveClass(inactiveClass);
  if ($$props.defaultClass === void 0 && $$bindings.defaultClass && defaultClass !== void 0)
    $$bindings.defaultClass(defaultClass);
  frameClass = twMerge(defaultClass, $$props.class);
  return `${validate_component(Frame, "Frame").$$render($$result, Object.assign({}, $$restProps, { class: frameClass }, { color: "none" }), {}, {
    default: () => {
      return `${slots.default ? slots.default({}) : ``}`;
    }
  })} `;
});
function sineIn(t) {
  const v = Math.cos(t * Math.PI * 0.5);
  if (Math.abs(v) < 1e-14)
    return 1;
  else
    return 1 - v;
}
function fade(node, { delay = 0, duration = 400, easing = identity } = {}) {
  const o = +getComputedStyle(node).opacity;
  return {
    delay,
    duration,
    easing,
    css: (t) => `opacity: ${t * o}`
  };
}
const AccordionItem = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let contentClass;
  let $$unsubscribe_selected;
  let { open = false } = $$props;
  let { activeClass = void 0 } = $$props;
  let { inactiveClass = void 0 } = $$props;
  let { defaultClass = "flex items-center justify-between w-full font-medium text-left group-first:rounded-t-xl border-gray-200 dark:border-gray-700" } = $$props;
  let { transitionType = "slide" } = $$props;
  let { transitionParams = {} } = $$props;
  let { paddingFlush = "py-5" } = $$props;
  let { paddingDefault = "p-5" } = $$props;
  let { textFlushOpen = "text-gray-900 dark:text-white" } = $$props;
  let { textFlushDefault = "text-gray-500 dark:text-gray-400" } = $$props;
  let { borderClass = "border-l border-r group-first:border-t" } = $$props;
  let { borderOpenClass = "border-l border-r" } = $$props;
  let { borderBottomClass = "border-b" } = $$props;
  let { borderSharedClass = "border-gray-200 dark:border-gray-700" } = $$props;
  let { classActive = void 0 } = $$props;
  let { classInactive = void 0 } = $$props;
  let activeCls = twMerge(activeClass, classActive);
  let inactiveCls = twMerge(inactiveClass, classInactive);
  const ctx = getContext("ctx") ?? {};
  const selected = ctx.selected ?? writable();
  $$unsubscribe_selected = subscribe(selected, (value) => value);
  open = false;
  let buttonClass;
  if ($$props.open === void 0 && $$bindings.open && open !== void 0)
    $$bindings.open(open);
  if ($$props.activeClass === void 0 && $$bindings.activeClass && activeClass !== void 0)
    $$bindings.activeClass(activeClass);
  if ($$props.inactiveClass === void 0 && $$bindings.inactiveClass && inactiveClass !== void 0)
    $$bindings.inactiveClass(inactiveClass);
  if ($$props.defaultClass === void 0 && $$bindings.defaultClass && defaultClass !== void 0)
    $$bindings.defaultClass(defaultClass);
  if ($$props.transitionType === void 0 && $$bindings.transitionType && transitionType !== void 0)
    $$bindings.transitionType(transitionType);
  if ($$props.transitionParams === void 0 && $$bindings.transitionParams && transitionParams !== void 0)
    $$bindings.transitionParams(transitionParams);
  if ($$props.paddingFlush === void 0 && $$bindings.paddingFlush && paddingFlush !== void 0)
    $$bindings.paddingFlush(paddingFlush);
  if ($$props.paddingDefault === void 0 && $$bindings.paddingDefault && paddingDefault !== void 0)
    $$bindings.paddingDefault(paddingDefault);
  if ($$props.textFlushOpen === void 0 && $$bindings.textFlushOpen && textFlushOpen !== void 0)
    $$bindings.textFlushOpen(textFlushOpen);
  if ($$props.textFlushDefault === void 0 && $$bindings.textFlushDefault && textFlushDefault !== void 0)
    $$bindings.textFlushDefault(textFlushDefault);
  if ($$props.borderClass === void 0 && $$bindings.borderClass && borderClass !== void 0)
    $$bindings.borderClass(borderClass);
  if ($$props.borderOpenClass === void 0 && $$bindings.borderOpenClass && borderOpenClass !== void 0)
    $$bindings.borderOpenClass(borderOpenClass);
  if ($$props.borderBottomClass === void 0 && $$bindings.borderBottomClass && borderBottomClass !== void 0)
    $$bindings.borderBottomClass(borderBottomClass);
  if ($$props.borderSharedClass === void 0 && $$bindings.borderSharedClass && borderSharedClass !== void 0)
    $$bindings.borderSharedClass(borderSharedClass);
  if ($$props.classActive === void 0 && $$bindings.classActive && classActive !== void 0)
    $$bindings.classActive(classActive);
  if ($$props.classInactive === void 0 && $$bindings.classInactive && classInactive !== void 0)
    $$bindings.classInactive(classInactive);
  buttonClass = twMerge([
    defaultClass,
    ctx.flush || borderClass,
    borderBottomClass,
    borderSharedClass,
    ctx.flush ? paddingFlush : paddingDefault,
    open && (ctx.flush ? textFlushOpen : activeCls || ctx.activeClass),
    !open && (ctx.flush ? textFlushDefault : inactiveCls || ctx.inactiveClass),
    $$props.class
  ]);
  contentClass = twMerge([
    ctx.flush ? paddingFlush : paddingDefault,
    ctx.flush ? "" : borderOpenClass,
    borderBottomClass,
    borderSharedClass
  ]);
  $$unsubscribe_selected();
  return `<h2 class="group"><button type="button"${add_attribute("class", buttonClass, 0)}${add_attribute("aria-expanded", open, 0)}>${slots.header ? slots.header({}) : ``} ${open ? `${slots.arrowup ? slots.arrowup({}) : ` <svg class="w-3 h-3 text-gray-800 dark:text-white" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 10 6"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5 5 1 1 5"></path></svg> `}` : `${slots.arrowdown ? slots.arrowdown({}) : ` <svg class="w-3 h-3 text-gray-800 dark:text-white" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 10 6"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m1 1 4 4 4-4"></path></svg> `}`}</button></h2> ${open ? `<div><div${add_attribute("class", contentClass, 0)}>${slots.default ? slots.default({}) : ``}</div></div>` : `<div class="hidden"><div${add_attribute("class", contentClass, 0)}>${slots.default ? slots.default({}) : ``}</div></div>`} `;
});
const ToolbarButton = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["color", "name", "ariaLabel", "size", "href"]);
  const background = getContext("background");
  let { color = "default" } = $$props;
  let { name = void 0 } = $$props;
  let { ariaLabel = void 0 } = $$props;
  let { size = "md" } = $$props;
  let { href = void 0 } = $$props;
  const colors = {
    dark: "text-gray-500 hover:text-gray-900 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-white dark:hover:bg-gray-600",
    gray: "text-gray-500 focus:ring-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800 dark:hover:text-gray-300",
    red: "text-red-500 focus:ring-red-400 hover:bg-red-200 dark:hover:bg-red-800 dark:hover:text-red-300",
    yellow: "text-yellow-500 focus:ring-yellow-400 hover:bg-yellow-200 dark:hover:bg-yellow-800 dark:hover:text-yellow-300",
    green: "text-green-500 focus:ring-green-400 hover:bg-green-200 dark:hover:bg-green-800 dark:hover:text-green-300",
    indigo: "text-indigo-500 focus:ring-indigo-400 hover:bg-indigo-200 dark:hover:bg-indigo-800 dark:hover:text-indigo-300",
    purple: "text-purple-500 focus:ring-purple-400 hover:bg-purple-200 dark:hover:bg-purple-800 dark:hover:text-purple-300",
    pink: "text-pink-500 focus:ring-pink-400 hover:bg-pink-200 dark:hover:bg-pink-800 dark:hover:text-pink-300",
    blue: "text-blue-500 focus:ring-blue-400 hover:bg-blue-200 dark:hover:bg-blue-800 dark:hover:text-blue-300",
    primary: "text-primary-500 focus:ring-primary-400 hover:bg-primary-200 dark:hover:bg-primary-800 dark:hover:text-primary-300",
    default: "focus:ring-gray-400"
  };
  const sizing = {
    xs: "m-0.5 rounded-sm focus:ring-1 p-0.5",
    sm: "m-0.5 rounded focus:ring-1 p-0.5",
    md: "m-0.5 rounded-lg focus:ring-2 p-1.5",
    lg: "m-0.5 rounded-lg focus:ring-2 p-2.5"
  };
  let buttonClass;
  const svgSizes = {
    xs: "w-3 h-3",
    sm: "w-3.5 h-3.5",
    md: "w-5 h-5",
    lg: "w-5 h-5"
  };
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  if ($$props.name === void 0 && $$bindings.name && name !== void 0)
    $$bindings.name(name);
  if ($$props.ariaLabel === void 0 && $$bindings.ariaLabel && ariaLabel !== void 0)
    $$bindings.ariaLabel(ariaLabel);
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.href === void 0 && $$bindings.href && href !== void 0)
    $$bindings.href(href);
  buttonClass = twMerge(
    "focus:outline-none whitespace-normal",
    sizing[size],
    colors[color],
    color === "default" && (background ? "hover:bg-gray-100 dark:hover:bg-gray-600" : "hover:bg-gray-100 dark:hover:bg-gray-700"),
    $$props.class
  );
  return `${href ? `<a${spread(
    [
      { href: escape_attribute_value(href) },
      escape_object($$restProps),
      {
        class: escape_attribute_value(buttonClass)
      },
      {
        "aria-label": escape_attribute_value(ariaLabel ?? name)
      }
    ],
    {}
  )}>${name ? `<span class="sr-only">${escape(name)}</span>` : ``} ${slots.default ? slots.default({ svgSize: svgSizes[size] }) : ``}</a>` : `<button${spread(
    [
      { type: "button" },
      escape_object($$restProps),
      {
        class: escape_attribute_value(buttonClass)
      },
      {
        "aria-label": escape_attribute_value(ariaLabel ?? name)
      }
    ],
    {}
  )}>${name ? `<span class="sr-only">${escape(name)}</span>` : ``} ${slots.default ? slots.default({ svgSize: svgSizes[size] }) : ``}</button>`} `;
});
const CloseButton = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["name"]);
  let { name = "Close" } = $$props;
  if ($$props.name === void 0 && $$bindings.name && name !== void 0)
    $$bindings.name(name);
  return `${validate_component(ToolbarButton, "ToolbarButton").$$render($$result, Object.assign({}, { name }, $$restProps, { class: twMerge("ml-auto", $$props.class) }), {}, {
    default: ({ svgSize }) => {
      return `<svg${add_attribute("class", svgSize, 0)} fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"></path></svg>`;
    }
  })} `;
});
const baseClass = "font-medium inline-flex items-center justify-center px-2.5 py-0.5";
const Badge = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["color", "large", "dismissable"]);
  let { color = "primary" } = $$props;
  let { large = false } = $$props;
  let { dismissable = false } = $$props;
  const colors = {
    primary: "bg-primary-100 text-primary-800 dark:bg-primary-900 dark:text-primary-300",
    blue: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
    dark: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
    gray: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
    red: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    green: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
    yellow: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
    indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300",
    purple: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
    pink: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300",
    none: ""
  };
  const borderedColors = {
    primary: "bg-primary-100 text-primary-800 dark:bg-gray-700 dark:text-primary-400 border-primary-400 dark:border-primary-400",
    blue: "bg-blue-100 text-blue-800 dark:bg-gray-700 dark:text-blue-400 border-blue-400 dark:border-blue-400",
    dark: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400 border-gray-500 dark:border-gray-500",
    red: "bg-red-100 text-red-800 dark:bg-gray-700 dark:text-red-400 border-red-400 dark:border-red-400",
    green: "bg-green-100 text-green-800 dark:bg-gray-700 dark:text-green-400 border-green-400 dark:border-green-400",
    yellow: "bg-yellow-100 text-yellow-800 dark:bg-gray-700 dark:text-yellow-300 border-yellow-300 dark:border-yellow-300",
    indigo: "bg-indigo-100 text-indigo-800 dark:bg-gray-700 dark:text-indigo-400 border-indigo-400 dark:border-indigo-400",
    purple: "bg-purple-100 text-purple-800 dark:bg-gray-700 dark:text-purple-400 border-purple-400 dark:border-purple-400",
    pink: "bg-pink-100 text-pink-800 dark:bg-gray-700 dark:text-pink-400 border-pink-400 dark:border-pink-400",
    none: ""
  };
  const hoverColors = {
    primary: "hover:bg-primary-200",
    blue: "hover:bg-blue-200",
    dark: "hover:bg-gray-200",
    red: "hover:bg-red-200",
    green: "hover:bg-green-200",
    yellow: "hover:bg-yellow-200",
    indigo: "hover:bg-indigo-200",
    purple: "hover:bg-purple-200",
    pink: "hover:bg-pink-200",
    none: ""
  };
  let badgeClass;
  let open = true;
  const dispatch = createEventDispatcher();
  const close = (e) => {
    e.stopPropagation();
    open = false;
  };
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  if ($$props.large === void 0 && $$bindings.large && large !== void 0)
    $$bindings.large(large);
  if ($$props.dismissable === void 0 && $$bindings.dismissable && dismissable !== void 0)
    $$bindings.dismissable(dismissable);
  {
    {
      if (dismissable)
        $$restProps.transition = $$restProps.transition ?? fade;
    }
  }
  badgeClass = twMerge(
    baseClass,
    large ? "text-sm" : "text-xs",
    $$restProps.border ? `border ${borderedColors[color]}` : colors[color],
    $$restProps.href && hoverColors[color],
    $$restProps.rounded ? "rounded-full" : "rounded",
    $$props.class
  );
  {
    dispatch(open ? "open" : "close");
  }
  return `${open ? `${validate_component(Frame, "Frame").$$render($$result, Object.assign({}, $$restProps, { class: badgeClass }), {}, {
    default: () => {
      return `${slots.default ? slots.default({}) : ``} ${dismissable ? `${slots["close-button"] ? slots["close-button"]({ close }) : ` ${validate_component(CloseButton, "CloseButton").$$render(
        $$result,
        {
          color,
          size: large ? "sm" : "xs",
          name: "Remove badge",
          class: "ml-1.5 -mr-1.5"
        },
        {},
        {}
      )} `}` : ``}`;
    }
  })}` : ``} `;
});
const Drawer = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, [
    "activateClickOutside",
    "hidden",
    "position",
    "leftOffset",
    "rightOffset",
    "topOffset",
    "bottomOffset",
    "width",
    "backdrop",
    "bgColor",
    "bgOpacity",
    "placement",
    "id",
    "divClass",
    "transitionParams",
    "transitionType"
  ]);
  let { activateClickOutside = true } = $$props;
  let { hidden = true } = $$props;
  let { position = "fixed" } = $$props;
  let { leftOffset = "inset-y-0 left-0" } = $$props;
  let { rightOffset = "inset-y-0 right-0" } = $$props;
  let { topOffset = "inset-x-0 top-0" } = $$props;
  let { bottomOffset = "inset-x-0 bottom-0" } = $$props;
  let { width = "w-80" } = $$props;
  let { backdrop = true } = $$props;
  let { bgColor = "bg-gray-900" } = $$props;
  let { bgOpacity = "bg-opacity-75" } = $$props;
  let { placement = "left" } = $$props;
  let { id = "drawer-example" } = $$props;
  let { divClass = "overflow-y-auto z-50 p-4 bg-white dark:bg-gray-800" } = $$props;
  let { transitionParams = {} } = $$props;
  let { transitionType = "fly" } = $$props;
  const placements = {
    left: leftOffset,
    right: rightOffset,
    top: topOffset,
    bottom: bottomOffset
  };
  let backdropDivClass = twMerge("fixed top-0 left-0 z-50 w-full h-full", backdrop && bgColor, backdrop && bgOpacity);
  if ($$props.activateClickOutside === void 0 && $$bindings.activateClickOutside && activateClickOutside !== void 0)
    $$bindings.activateClickOutside(activateClickOutside);
  if ($$props.hidden === void 0 && $$bindings.hidden && hidden !== void 0)
    $$bindings.hidden(hidden);
  if ($$props.position === void 0 && $$bindings.position && position !== void 0)
    $$bindings.position(position);
  if ($$props.leftOffset === void 0 && $$bindings.leftOffset && leftOffset !== void 0)
    $$bindings.leftOffset(leftOffset);
  if ($$props.rightOffset === void 0 && $$bindings.rightOffset && rightOffset !== void 0)
    $$bindings.rightOffset(rightOffset);
  if ($$props.topOffset === void 0 && $$bindings.topOffset && topOffset !== void 0)
    $$bindings.topOffset(topOffset);
  if ($$props.bottomOffset === void 0 && $$bindings.bottomOffset && bottomOffset !== void 0)
    $$bindings.bottomOffset(bottomOffset);
  if ($$props.width === void 0 && $$bindings.width && width !== void 0)
    $$bindings.width(width);
  if ($$props.backdrop === void 0 && $$bindings.backdrop && backdrop !== void 0)
    $$bindings.backdrop(backdrop);
  if ($$props.bgColor === void 0 && $$bindings.bgColor && bgColor !== void 0)
    $$bindings.bgColor(bgColor);
  if ($$props.bgOpacity === void 0 && $$bindings.bgOpacity && bgOpacity !== void 0)
    $$bindings.bgOpacity(bgOpacity);
  if ($$props.placement === void 0 && $$bindings.placement && placement !== void 0)
    $$bindings.placement(placement);
  if ($$props.id === void 0 && $$bindings.id && id !== void 0)
    $$bindings.id(id);
  if ($$props.divClass === void 0 && $$bindings.divClass && divClass !== void 0)
    $$bindings.divClass(divClass);
  if ($$props.transitionParams === void 0 && $$bindings.transitionParams && transitionParams !== void 0)
    $$bindings.transitionParams(transitionParams);
  if ($$props.transitionType === void 0 && $$bindings.transitionType && transitionType !== void 0)
    $$bindings.transitionType(transitionType);
  return `${!hidden ? `${backdrop && activateClickOutside ? `<div role="presentation"${add_attribute("class", backdropDivClass, 0)}></div>` : `${backdrop && !activateClickOutside ? `<div role="presentation"${add_attribute("class", backdropDivClass, 0)}></div>` : ``}`} <div${spread(
    [
      { id: escape_attribute_value(id) },
      escape_object($$restProps),
      {
        class: escape_attribute_value(twMerge(divClass, width, position, placements[placement], $$props.class))
      },
      { tabindex: "-1" },
      {
        "aria-controls": escape_attribute_value(id)
      },
      {
        "aria-labelledby": escape_attribute_value(id)
      }
    ],
    {}
  )}>${slots.default ? slots.default({ hidden }) : ``}</div>` : ``} `;
});
const Label = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let labelClass2;
  let $$restProps = compute_rest_props($$props, ["color", "defaultClass", "show"]);
  let { color = "gray" } = $$props;
  let { defaultClass = "text-sm font-medium block" } = $$props;
  let { show = true } = $$props;
  let node;
  const colorClasses2 = {
    gray: "text-gray-900 dark:text-gray-300",
    green: "text-green-700 dark:text-green-500",
    red: "text-red-700 dark:text-red-500",
    disabled: "text-gray-400 dark:text-gray-500"
  };
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  if ($$props.defaultClass === void 0 && $$bindings.defaultClass && defaultClass !== void 0)
    $$bindings.defaultClass(defaultClass);
  if ($$props.show === void 0 && $$bindings.show && show !== void 0)
    $$bindings.show(show);
  {
    {
      color = color;
    }
  }
  labelClass2 = twMerge(defaultClass, colorClasses2[color], $$props.class);
  return `${show ? ` <label${spread(
    [
      escape_object($$restProps),
      {
        class: escape_attribute_value(labelClass2)
      }
    ],
    {}
  )}${add_attribute("this", node, 0)}>${slots.default ? slots.default({}) : ``}</label>` : `${slots.default ? slots.default({}) : ``}`} `;
});
const colorClasses = {
  primary: "text-primary-600 focus:ring-primary-500 dark:focus:ring-primary-600",
  secondary: "text-secondary-600 focus:ring-secondary-500 dark:focus:ring-secondary-600",
  red: "text-red-600 focus:ring-red-500 dark:focus:ring-red-600",
  green: "text-green-600 focus:ring-green-500 dark:focus:ring-green-600",
  purple: "text-purple-600 focus:ring-purple-500 dark:focus:ring-purple-600",
  teal: "text-teal-600 focus:ring-teal-500 dark:focus:ring-teal-600",
  yellow: "text-yellow-400 focus:ring-yellow-500 dark:focus:ring-yellow-600",
  orange: "text-orange-500 focus:ring-orange-500 dark:focus:ring-orange-600",
  blue: "text-blue-600 focus:ring-blue-500 dark:focus:ring-blue-600"
};
const labelClass = (inline, extraClass) => twMerge(inline ? "inline-flex" : "flex", "items-center", extraClass);
let spacing = "mr-2";
const inputClass = (custom, color, rounded, tinted, extraClass) => twMerge(
  "w-4 h-4 bg-gray-100 border-gray-300 dark:ring-offset-gray-800 focus:ring-2",
  spacing,
  tinted ? "dark:bg-gray-600 dark:border-gray-500" : "dark:bg-gray-700 dark:border-gray-600",
  custom && "sr-only peer",
  rounded && "rounded",
  colorClasses[color],
  extraClass
);
const Checkbox = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["color", "custom", "inline", "group", "value", "checked", "spacing"]);
  let $$slots = compute_slots(slots);
  let { color = "primary" } = $$props;
  let { custom = false } = $$props;
  let { inline = false } = $$props;
  let { group = [] } = $$props;
  let { value = "on" } = $$props;
  let { checked = void 0 } = $$props;
  let { spacing: spacing2 = "mr-2" } = $$props;
  let background = getContext("background");
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  if ($$props.custom === void 0 && $$bindings.custom && custom !== void 0)
    $$bindings.custom(custom);
  if ($$props.inline === void 0 && $$bindings.inline && inline !== void 0)
    $$bindings.inline(inline);
  if ($$props.group === void 0 && $$bindings.group && group !== void 0)
    $$bindings.group(group);
  if ($$props.value === void 0 && $$bindings.value && value !== void 0)
    $$bindings.value(value);
  if ($$props.checked === void 0 && $$bindings.checked && checked !== void 0)
    $$bindings.checked(checked);
  if ($$props.spacing === void 0 && $$bindings.spacing && spacing2 !== void 0)
    $$bindings.spacing(spacing2);
  return `${validate_component(Label, "Label").$$render(
    $$result,
    {
      class: labelClass(inline, $$props.class),
      show: $$slots.default
    },
    {},
    {
      default: () => {
        return `<input${spread(
          [
            { type: "checkbox" },
            { value: escape_attribute_value(value) },
            escape_object($$restProps),
            {
              class: escape_attribute_value(twMerge(spacing2, inputClass(custom, color, true, background, $$slots.default || $$props.class)))
            }
          ],
          {}
        )}${add_attribute("checked", checked, 1)}> ${slots.default ? slots.default({}) : ``}`;
      }
    }
  )} `;
});
const Helper = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["helperClass", "color"]);
  let { helperClass = "text-xs font-normal text-gray-500 dark:text-gray-300" } = $$props;
  let { color = "gray" } = $$props;
  const colorClasses2 = {
    gray: "text-gray-900 dark:text-gray-300",
    green: "text-green-700 dark:text-green-500",
    red: "text-red-700 dark:text-red-500",
    disabled: "text-gray-400 dark:text-gray-500"
  };
  if ($$props.helperClass === void 0 && $$bindings.helperClass && helperClass !== void 0)
    $$bindings.helperClass(helperClass);
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  return `<p${spread(
    [
      escape_object($$restProps),
      {
        class: escape_attribute_value(twMerge(helperClass, colorClasses2[color], $$props.class))
      }
    ],
    {}
  )}>${slots.default ? slots.default({}) : ``}</p> `;
});
const Range = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["value", "size"]);
  let { value } = $$props;
  let { size = "md" } = $$props;
  const sizes = {
    sm: "h-1 range-sm",
    md: "h-2",
    lg: "h-3 range-lg"
  };
  let inputClass2;
  if ($$props.value === void 0 && $$bindings.value && value !== void 0)
    $$bindings.value(value);
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  inputClass2 = twMerge("w-full bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700", sizes[size] ?? sizes.md, $$props.class);
  return `<input${spread(
    [
      { type: "range" },
      escape_object($$restProps),
      {
        class: escape_attribute_value(inputClass2)
      }
    ],
    {}
  )}${add_attribute("value", value, 0)}> `;
});
const common$1 = "block w-full";
const Select = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, [
    "items",
    "value",
    "placeholder",
    "underline",
    "size",
    "defaultClass",
    "underlineClass"
  ]);
  let { items = [] } = $$props;
  let { value = void 0 } = $$props;
  let { placeholder = "Choose option ..." } = $$props;
  let { underline = false } = $$props;
  let { size = "md" } = $$props;
  let { defaultClass = "text-gray-900 bg-gray-50 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-primary-500 dark:focus:border-primary-500" } = $$props;
  let { underlineClass = "text-gray-500 bg-transparent border-0 border-b-2 border-gray-200 appearance-none dark:text-gray-400 dark:border-gray-700 focus:outline-none focus:ring-0 focus:border-gray-200 peer" } = $$props;
  const sizes = {
    sm: "text-sm p-2",
    md: "text-sm p-2.5",
    lg: "text-base py-3 px-4"
  };
  let selectClass;
  if ($$props.items === void 0 && $$bindings.items && items !== void 0)
    $$bindings.items(items);
  if ($$props.value === void 0 && $$bindings.value && value !== void 0)
    $$bindings.value(value);
  if ($$props.placeholder === void 0 && $$bindings.placeholder && placeholder !== void 0)
    $$bindings.placeholder(placeholder);
  if ($$props.underline === void 0 && $$bindings.underline && underline !== void 0)
    $$bindings.underline(underline);
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.defaultClass === void 0 && $$bindings.defaultClass && defaultClass !== void 0)
    $$bindings.defaultClass(defaultClass);
  if ($$props.underlineClass === void 0 && $$bindings.underlineClass && underlineClass !== void 0)
    $$bindings.underlineClass(underlineClass);
  selectClass = twMerge(common$1, underline ? underlineClass : defaultClass, sizes[size], underline && "!px-0", $$props.class);
  return `<select${spread(
    [
      escape_object($$restProps),
      {
        class: escape_attribute_value(selectClass)
      }
    ],
    {}
  )}>${placeholder ? `<option disabled selected value="">${escape(placeholder)}</option>` : ``}${items.length ? each(items, ({ value: value2, name }) => {
    return `<option${add_attribute("value", value2, 0)}>${escape(name)}</option>`;
  }) : `${slots.default ? slots.default({}) : ``}`}</select> `;
});
const common = "mr-3 shrink-0 bg-gray-200 rounded-full peer-focus:ring-4 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:bg-white after:border-gray-300 after:border after:rounded-full after:transition-all";
const Toggle = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["size", "group", "value", "checked", "customSize"]);
  let { size = "default" } = $$props;
  let { group = [] } = $$props;
  let { value = "" } = $$props;
  let { checked = void 0 } = $$props;
  let { customSize = "" } = $$props;
  let background = getContext("background");
  const colors = {
    primary: "peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 peer-checked:bg-primary-600",
    secondary: "peer-focus:ring-secondary-300 dark:peer-focus:ring-secondary-800 peer-checked:bg-secondary-600",
    red: "peer-focus:ring-red-300 dark:peer-focus:ring-red-800 peer-checked:bg-red-600",
    green: "peer-focus:ring-green-300 dark:peer-focus:ring-green-800 peer-checked:bg-green-600",
    purple: "peer-focus:ring-purple-300 dark:peer-focus:ring-purple-800 peer-checked:bg-purple-600",
    yellow: "peer-focus:ring-yellow-300 dark:peer-focus:ring-yellow-800 peer-checked:bg-yellow-400",
    teal: "peer-focus:ring-teal-300 dark:peer-focus:ring-teal-800 peer-checked:bg-teal-600",
    orange: "peer-focus:ring-orange-300 dark:peer-focus:ring-orange-800 peer-checked:bg-orange-500",
    blue: "peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 peer-checked:bg-blue-600"
  };
  const sizes = {
    small: "w-9 h-5 after:top-[2px] after:left-[2px] after:h-4 after:w-4",
    default: "w-11 h-6 after:top-0.5 after:left-[2px] after:h-5 after:w-5",
    large: "w-14 h-7 after:top-0.5 after:left-[4px]  after:h-6 after:w-6",
    custom: customSize
  };
  let divClass;
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.group === void 0 && $$bindings.group && group !== void 0)
    $$bindings.group(group);
  if ($$props.value === void 0 && $$bindings.value && value !== void 0)
    $$bindings.value(value);
  if ($$props.checked === void 0 && $$bindings.checked && checked !== void 0)
    $$bindings.checked(checked);
  if ($$props.customSize === void 0 && $$bindings.customSize && customSize !== void 0)
    $$bindings.customSize(customSize);
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    divClass = twMerge(
      common,
      background ? "dark:bg-gray-600 dark:border-gray-500" : "dark:bg-gray-700 dark:border-gray-600",
      colors[$$restProps.color ?? "primary"],
      sizes[size],
      "relative",
      $$props.classDiv
    );
    $$rendered = `${validate_component(Checkbox, "Checkbox").$$render(
      $$result,
      Object.assign({}, { custom: true }, $$restProps, { class: $$props.class }, { value }, { checked }, { group }),
      {
        checked: ($$value) => {
          checked = $$value;
          $$settled = false;
        },
        group: ($$value) => {
          group = $$value;
          $$settled = false;
        }
      },
      {
        default: () => {
          return `<span${add_attribute("class", divClass, 0)}></span> ${slots.default ? slots.default({}) : ``}`;
        }
      }
    )} `;
  } while (!$$settled);
  return $$rendered;
});
const Modal = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, [
    "open",
    "title",
    "size",
    "placement",
    "autoclose",
    "dismissable",
    "backdropClass",
    "defaultClass",
    "outsideclose",
    "dialogClass"
  ]);
  let $$slots = compute_slots(slots);
  let { open = false } = $$props;
  let { title = "" } = $$props;
  let { size = "md" } = $$props;
  let { placement = "center" } = $$props;
  let { autoclose = false } = $$props;
  let { dismissable = true } = $$props;
  let { backdropClass = "fixed inset-0 z-40 bg-gray-900 bg-opacity-50 dark:bg-opacity-80" } = $$props;
  let { defaultClass = "relative flex flex-col mx-auto" } = $$props;
  let { outsideclose = false } = $$props;
  let { dialogClass = "fixed top-0 left-0 right-0 h-modal md:inset-0 md:h-full z-50 w-full p-4 flex" } = $$props;
  const dispatch = createEventDispatcher();
  const getPlacementClasses = () => {
    switch (placement) {
      case "top-left":
        return ["justify-start", "items-start"];
      case "top-center":
        return ["justify-center", "items-start"];
      case "top-right":
        return ["justify-end", "items-start"];
      case "center-left":
        return ["justify-start", "items-center"];
      case "center":
        return ["justify-center", "items-center"];
      case "center-right":
        return ["justify-end", "items-center"];
      case "bottom-left":
        return ["justify-start", "items-end"];
      case "bottom-center":
        return ["justify-center", "items-end"];
      case "bottom-right":
        return ["justify-end", "items-end"];
      default:
        return ["justify-center", "items-center"];
    }
  };
  const sizes = {
    xs: "max-w-md",
    sm: "max-w-lg",
    md: "max-w-2xl",
    lg: "max-w-4xl",
    xl: "max-w-7xl"
  };
  let frameClass;
  let backdropCls = twMerge(backdropClass, $$props.classBackdrop);
  if ($$props.open === void 0 && $$bindings.open && open !== void 0)
    $$bindings.open(open);
  if ($$props.title === void 0 && $$bindings.title && title !== void 0)
    $$bindings.title(title);
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.placement === void 0 && $$bindings.placement && placement !== void 0)
    $$bindings.placement(placement);
  if ($$props.autoclose === void 0 && $$bindings.autoclose && autoclose !== void 0)
    $$bindings.autoclose(autoclose);
  if ($$props.dismissable === void 0 && $$bindings.dismissable && dismissable !== void 0)
    $$bindings.dismissable(dismissable);
  if ($$props.backdropClass === void 0 && $$bindings.backdropClass && backdropClass !== void 0)
    $$bindings.backdropClass(backdropClass);
  if ($$props.defaultClass === void 0 && $$bindings.defaultClass && defaultClass !== void 0)
    $$bindings.defaultClass(defaultClass);
  if ($$props.outsideclose === void 0 && $$bindings.outsideclose && outsideclose !== void 0)
    $$bindings.outsideclose(outsideclose);
  if ($$props.dialogClass === void 0 && $$bindings.dialogClass && dialogClass !== void 0)
    $$bindings.dialogClass(dialogClass);
  {
    dispatch(open ? "open" : "close");
  }
  frameClass = twMerge(defaultClass, "w-full", $$props.class);
  return `${open ? ` <div${add_attribute("class", backdropCls, 0)}></div>   <div${add_attribute("class", twMerge(dialogClass, $$props.classDialog, ...getPlacementClasses()), 0)} tabindex="-1" aria-modal="true" role="dialog"><div class="${"flex relative " + escape(sizes[size], true) + " w-full max-h-full"}"> ${validate_component(Frame, "Frame").$$render($$result, Object.assign({}, { rounded: true }, { shadow: true }, $$restProps, { class: frameClass }), {}, {
    default: () => {
      return ` ${$$slots.header || title ? `${validate_component(Frame, "Frame").$$render(
        $$result,
        {
          color: $$restProps.color,
          class: "flex justify-between items-center p-4 rounded-t border-b"
        },
        {},
        {
          default: () => {
            return `${slots.header ? slots.header({}) : ` <h3 class="${"text-xl font-semibold " + escape($$restProps.color ? "" : "text-gray-900 dark:text-white", true) + " p-0"}">${escape(title)}</h3> `} ${dismissable ? `${validate_component(CloseButton, "CloseButton").$$render(
              $$result,
              {
                name: "Close modal",
                color: $$restProps.color
              },
              {},
              {}
            )}` : ``}`;
          }
        }
      )}` : `${dismissable ? `${validate_component(CloseButton, "CloseButton").$$render(
        $$result,
        {
          name: "Close modal",
          class: "absolute top-3 right-2.5",
          color: $$restProps.color
        },
        {},
        {}
      )}` : ``}`}  <div${add_attribute("class", twMerge("p-6 space-y-6 flex-1 overflow-y-auto overscroll-contain", $$props.bodyClass), 0)} role="document">${slots.default ? slots.default({}) : ``}</div>  ${$$slots.footer ? `${validate_component(Frame, "Frame").$$render(
        $$result,
        {
          color: $$restProps.color,
          class: "flex items-center p-6 space-x-2 rounded-b border-t"
        },
        {},
        {
          default: () => {
            return `${slots.footer ? slots.footer({}) : ``}`;
          }
        }
      )}` : ``}`;
    }
  })}</div></div>` : ``} `;
});
const A = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["href", "color", "aClass"]);
  let { href = "#" } = $$props;
  let { color = "text-primary-600 dark:text-primary-500" } = $$props;
  let { aClass = "inline-flex items-center hover:underline" } = $$props;
  if ($$props.href === void 0 && $$bindings.href && href !== void 0)
    $$bindings.href(href);
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  if ($$props.aClass === void 0 && $$bindings.aClass && aClass !== void 0)
    $$bindings.aClass(aClass);
  return `<a${spread(
    [
      escape_object($$restProps),
      { href: escape_attribute_value(href) },
      {
        class: escape_attribute_value(twMerge(aClass, color, $$props.class))
      }
    ],
    {}
  )}>${slots.default ? slots.default({}) : ``}</a> `;
});
const CirclePlusSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "circle plus solid" } = $$props;
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
  )}><path fill="currentColor" d="M9.546.5a9.5 9.5 0 1 0 9.5 9.5 9.51 9.51 0 0 0-9.5-9.5ZM13.788 11h-3.242v3.242a1 1 0 1 1-2 0V11H5.304a1 1 0 0 1 0-2h3.242V5.758a1 1 0 0 1 2 0V9h3.242a1 1 0 1 1 0 2Z"></path></svg> `;
});
const CopySolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "copy solid" } = $$props;
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
      { viewBox: "0 0 16 20" }
    ],
    {}
  )}><g fill="currentColor"><path d="M2 18V5.828a4.979 4.979 0 0 1 .332-1.761A.992.992 0 0 0 2 4a2 2 0 0 0-2 2v12a1.97 1.97 0 0 0 1.934 2h8.1a1.99 1.99 0 0 0 1.994-2H2ZM9 5V.13a2.98 2.98 0 0 0-1.293.749L4.879 3.707A2.98 2.98 0 0 0 4.13 5H9Z"></path><path d="M14.066 0H11v5a2 2 0 0 1-2 2H4v7a1.97 1.97 0 0 0 1.934 2h8.132A1.97 1.97 0 0 0 16 14V2a1.97 1.97 0 0 0-1.934-2Z"></path></g></svg> `;
});
const EditOutline = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "edit outline" } = $$props;
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
  )}><path stroke="currentColor"${add_attribute("stroke-linecap", strokeLinecap, 0)}${add_attribute("stroke-linejoin", strokeLinejoin, 0)}${add_attribute("stroke-width", strokeWidth, 0)} d="M15 13v2.833A1.166 1.166 0 0 1 13.833 17H2.167A1.167 1.167 0 0 1 1 15.833V4.167A1.166 1.166 0 0 1 2.167 3h6.616m5.521-.156 2.852 2.852m1.253-4.105a2.017 2.017 0 0 1 0 2.852l-7.844 7.844L7 13l.713-3.565 7.844-7.844a2.016 2.016 0 0 1 2.852 0Z"></path></svg> `;
});
const GithubSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "github solid" } = $$props;
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
  )}><path fill="currentColor" fill-rule="evenodd" d="M10 .333A9.911 9.911 0 0 0 6.866 19.65c.5.092.678-.215.678-.477 0-.237-.01-1.017-.014-1.845-2.757.6-3.338-1.169-3.338-1.169a2.627 2.627 0 0 0-1.1-1.451c-.9-.615.069-.6.069-.6a2.084 2.084 0 0 1 1.519 1.021 2.11 2.11 0 0 0 2.884.823c.044-.503.267-.973.629-1.325-2.2-.25-4.515-1.1-4.515-4.9A3.832 3.832 0 0 1 4.7 7.068a3.56 3.56 0 0 1 .095-2.623s.832-.266 2.726 1.016a9.409 9.409 0 0 1 4.962 0c1.89-1.282 2.717-1.016 2.717-1.016.366.83.402 1.768.1 2.623a3.827 3.827 0 0 1 1.02 2.659c0 3.807-2.319 4.644-4.525 4.889a2.366 2.366 0 0 1 .673 1.834c0 1.326-.012 2.394-.012 2.72 0 .263.179.572.681.475A9.91 9.91 0 0 0 10 .333Z" clip-rule="evenodd"></path></svg> `;
});
const UserEditSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "user edit solid" } = $$props;
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
      { viewBox: "0 0 20 18" }
    ],
    {}
  )}><path fill="currentColor" d="M6.5 9a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm-1.391 7.361.707-3.535a3 3 0 0 1 .82-1.533L7.929 10H5a5.006 5.006 0 0 0-5 5v2a1 1 0 0 0 1 1h4.259a2.975 2.975 0 0 1-.15-1.639ZM8.05 17.95a1 1 0 0 1-.981-1.2l.708-3.536a1 1 0 0 1 .274-.511l6.363-6.364a3.007 3.007 0 0 1 4.243 0 3.007 3.007 0 0 1 0 4.243l-6.365 6.363a1 1 0 0 1-.511.274l-3.536.708a1.07 1.07 0 0 1-.195.023Z"></path></svg> `;
});
const UserSettingsSolid = create_ssr_component(($$result, $$props, $$bindings, slots) => {
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
  let { ariaLabel = "user settings solid" } = $$props;
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
      { viewBox: "0 0 20 19" }
    ],
    {}
  )}><path fill="currentColor" d="M7.324 9.917A2.479 2.479 0 0 1 7.99 7.7l.71-.71a2.484 2.484 0 0 1 2.222-.688 4.538 4.538 0 1 0-3.6 3.615h.002ZM7.99 18.3a2.5 2.5 0 0 1-.6-2.564A2.5 2.5 0 0 1 6 13.5v-1c.005-.544.19-1.072.526-1.5H5a5.006 5.006 0 0 0-5 5v2a1 1 0 0 0 1 1h7.687l-.697-.7ZM19.5 12h-1.12a4.441 4.441 0 0 0-.579-1.387l.8-.795a.5.5 0 0 0 0-.707l-.707-.707a.5.5 0 0 0-.707 0l-.795.8A4.443 4.443 0 0 0 15 8.62V7.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.12c-.492.113-.96.309-1.387.579l-.795-.795a.5.5 0 0 0-.707 0l-.707.707a.5.5 0 0 0 0 .707l.8.8c-.272.424-.47.891-.584 1.382H8.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1.12c.113.492.309.96.579 1.387l-.795.795a.5.5 0 0 0 0 .707l.707.707a.5.5 0 0 0 .707 0l.8-.8c.424.272.892.47 1.382.584v1.12a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1.12c.492-.113.96-.309 1.387-.579l.795.8a.5.5 0 0 0 .707 0l.707-.707a.5.5 0 0 0 0-.707l-.8-.795c.273-.427.47-.898.584-1.392h1.12a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5ZM14 15.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z"></path></svg> `;
});
function client_method(key) {
  {
    if (key === "before_navigate" || key === "after_navigate" || key === "on_navigate") {
      return () => {
      };
    } else {
      const name_lookup = {
        disable_scroll_handling: "disableScrollHandling",
        preload_data: "preloadData",
        preload_code: "preloadCode",
        invalidate_all: "invalidateAll"
      };
      return () => {
        throw new Error(`Cannot call ${name_lookup[key] ?? key}(...) on the server`);
      };
    }
  }
}
const beforeNavigate = /* @__PURE__ */ client_method("before_navigate");
const afterNavigate = /* @__PURE__ */ client_method("after_navigate");
function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}
function isReader() {
  return get_store_value(page).route.id === "/[manga]/[volume]";
}
function fireExstaticEvent(event, payload) {
}
const AnkiConnectSettings = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let disabled;
  let $settings, $$unsubscribe_settings;
  let $page, $$unsubscribe_page;
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  $$unsubscribe_page = subscribe(page, (value) => $page = value);
  let enabled = $settings.ankiConnectSettings.enabled;
  let cropImage = $settings.ankiConnectSettings.cropImage;
  let grabSentence = $settings.ankiConnectSettings.grabSentence;
  let overwriteImage = $settings.ankiConnectSettings.overwriteImage;
  let pictureField = $settings.ankiConnectSettings.pictureField;
  let sentenceField = $settings.ankiConnectSettings.sentenceField;
  let triggerMethod = $settings.ankiConnectSettings.triggerMethod;
  const triggerOptions = [
    {
      value: "rightClick",
      name: "Right click (long press on mobile)"
    },
    { value: "doubleTap", name: "Double tap" },
    { value: "both", name: "Both" },
    { value: "neither", name: "Neither" }
  ];
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    disabled = !$settings.ankiConnectSettings.enabled;
    $$rendered = `${validate_component(AccordionItem, "AccordionItem").$$render($$result, {}, {}, {
      header: () => {
        return `<span slot="header" data-svelte-h="svelte-fm0ee3">Anki Connect</span>`;
      },
      default: () => {
        return `<div class="flex flex-col gap-5">${validate_component(Helper, "Helper").$$render($$result, {}, {}, {
          default: () => {
            return `For anki connect integration to work, you must add the reader (<code class="text-primary-500">${escape($page.url.origin)}</code>) to your anki connect <b class="text-primary-500" data-svelte-h="svelte-1i44hoc">webCorsOriginList</b> list`;
          }
        })} ${validate_component(Helper, "Helper").$$render($$result, {}, {}, {
          default: () => {
            return `To trigger the anki connect integration, double click or right click (long press on mobile)
      any text box.`;
          }
        })} <div>${validate_component(Toggle, "Toggle").$$render(
          $$result,
          { checked: enabled },
          {
            checked: ($$value) => {
              enabled = $$value;
              $$settled = false;
            }
          },
          {
            default: () => {
              return `AnkiConnect Integration Enabled`;
            }
          }
        )}</div> <div>${validate_component(Label, "Label").$$render($$result, {}, {}, {
          default: () => {
            return `Picture field:`;
          }
        })} ${validate_component(Input, "Input").$$render(
          $$result,
          {
            disabled,
            type: "text",
            value: pictureField
          },
          {
            value: ($$value) => {
              pictureField = $$value;
              $$settled = false;
            }
          },
          {}
        )}</div> <div>${validate_component(Label, "Label").$$render($$result, {}, {}, {
          default: () => {
            return `Sentence field:`;
          }
        })} ${validate_component(Input, "Input").$$render(
          $$result,
          {
            disabled,
            type: "text",
            value: sentenceField
          },
          {
            value: ($$value) => {
              sentenceField = $$value;
              $$settled = false;
            }
          },
          {}
        )}</div> <div>${validate_component(Toggle, "Toggle").$$render(
          $$result,
          { disabled, checked: cropImage },
          {
            checked: ($$value) => {
              cropImage = $$value;
              $$settled = false;
            }
          },
          {
            default: () => {
              return `Crop image`;
            }
          }
        )}</div> <div>${validate_component(Toggle, "Toggle").$$render(
          $$result,
          { disabled, checked: overwriteImage },
          {
            checked: ($$value) => {
              overwriteImage = $$value;
              $$settled = false;
            }
          },
          {
            default: () => {
              return `Overwrite image`;
            }
          }
        )}</div> <div>${validate_component(Toggle, "Toggle").$$render(
          $$result,
          { disabled, checked: grabSentence },
          {
            checked: ($$value) => {
              grabSentence = $$value;
              $$settled = false;
            }
          },
          {
            default: () => {
              return `Grab sentence`;
            }
          }
        )}</div> <div>${validate_component(Label, "Label").$$render($$result, {}, {}, {
          default: () => {
            return `Trigger method:
        ${validate_component(Select, "Select").$$render(
              $$result,
              {
                items: triggerOptions,
                value: triggerMethod
              },
              {
                value: ($$value) => {
                  triggerMethod = $$value;
                  $$settled = false;
                }
              },
              {}
            )}`;
          }
        })}</div></div>`;
      }
    })}`;
  } while (!$$settled);
  $$unsubscribe_settings();
  $$unsubscribe_page();
  return $$rendered;
});
const ReaderSelects = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let zoomModeValue;
  let fontSizeValue;
  let $settings, $$unsubscribe_settings;
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  let zoomModes = [
    {
      value: "zoomFitToScreen",
      name: "Fit to screen"
    },
    {
      value: "zoomFitToWidth",
      name: "Fit to width"
    },
    {
      value: "zoomOriginal",
      name: "Original size"
    },
    { value: "keepZoom", name: "Keep zoom" },
    {
      value: "keepZoomStart",
      name: "Keep zoom, pan to top"
    }
  ];
  let fontSizes = [
    { value: "auto", name: "auto" },
    { value: "9", name: "9" },
    { value: "10", name: "10" },
    { value: "11", name: "11" },
    { value: "12", name: "12" },
    { value: "14", name: "14" },
    { value: "16", name: "16" },
    { value: "18", name: "18" },
    { value: "20", name: "20" },
    { value: "24", name: "24" },
    { value: "32", name: "32" },
    { value: "40", name: "40" },
    { value: "48", name: "48" },
    { value: "60", name: "60" }
  ];
  zoomModeValue = $settings.zoomDefault;
  fontSizeValue = $settings.fontSize;
  $$unsubscribe_settings();
  return `<div>${validate_component(Label, "Label").$$render($$result, {}, {}, {
    default: () => {
      return `On page zoom:`;
    }
  })} ${validate_component(Select, "Select").$$render($$result, { items: zoomModes, value: zoomModeValue }, {}, {})}</div> <div>${validate_component(Label, "Label").$$render($$result, {}, {}, {
    default: () => {
      return `Fontsize:`;
    }
  })} ${validate_component(Select, "Select").$$render($$result, { items: fontSizes, value: fontSizeValue }, {}, {})}</div> <div>${validate_component(Label, "Label").$$render($$result, {}, {}, {
    default: () => {
      return `Background color:`;
    }
  })} ${validate_component(Input, "Input").$$render(
    $$result,
    {
      type: "color",
      value: $settings.backgroundColor
    },
    {},
    {}
  )}</div>`;
});
const ReaderToggles = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let toggles;
  let $settings, $$unsubscribe_settings;
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  toggles = [
    {
      key: "defaultFullscreen",
      text: "Open reader in fullscreen",
      value: $settings.defaultFullscreen
    },
    {
      key: "textEditable",
      text: "Editable text",
      value: $settings.textEditable
    },
    {
      key: "textBoxBorders",
      text: "Text box borders",
      value: $settings.textBoxBorders
    },
    {
      key: "displayOCR",
      text: "OCR enabled",
      value: $settings.displayOCR
    },
    {
      key: "boldFont",
      text: "Bold font",
      value: $settings.boldFont
    },
    {
      key: "pageNum",
      text: "Show page number",
      value: $settings.pageNum
    },
    {
      key: "charCount",
      text: "Show character count",
      value: $settings.charCount
    },
    {
      key: "bounds",
      text: "Bounds",
      value: $settings.bounds
    },
    {
      key: "mobile",
      text: "Mobile",
      value: $settings.mobile
    },
    {
      key: "showTimer",
      text: "Show timer",
      value: $settings.showTimer
    },
    {
      key: "quickActions",
      text: "Show quick actions",
      value: $settings.quickActions
    },
    {
      key: "invertColors",
      text: "Invert colors of the images",
      value: $settings.invertColors
    }
  ];
  $$unsubscribe_settings();
  return `${each(toggles, ({ key, text, value }) => {
    return `${validate_component(Toggle, "Toggle").$$render($$result, { size: "small", checked: value }, {}, {
      default: () => {
        return `${escape(text)}`;
      }
    })}`;
  })}`;
});
const ReaderSettings = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $settings, $$unsubscribe_settings;
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  let swipeThresholdValue = $settings.swipeThreshold;
  let edgeButtonWidthValue = $settings.edgeButtonWidth;
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    $$rendered = `${validate_component(AccordionItem, "AccordionItem").$$render($$result, {}, {}, {
      header: () => {
        return `<span slot="header" data-svelte-h="svelte-uova1">Reader</span>`;
      },
      default: () => {
        return `<div class="flex flex-col gap-5">${validate_component(ReaderSelects, "ReaderSelects").$$render($$result, {}, {}, {})} <hr class="border-gray-100 opacity-10"> ${validate_component(ReaderToggles, "ReaderToggles").$$render($$result, {}, {}, {})} <div>${validate_component(Label, "Label").$$render($$result, {}, {}, {
          default: () => {
            return `Swipe threshold`;
          }
        })} ${validate_component(Range, "Range").$$render(
          $$result,
          {
            min: 20,
            max: 90,
            disabled: !$settings.mobile,
            value: swipeThresholdValue
          },
          {
            value: ($$value) => {
              swipeThresholdValue = $$value;
              $$settled = false;
            }
          },
          {}
        )}</div> <div>${validate_component(Label, "Label").$$render($$result, {}, {}, {
          default: () => {
            return `Edge button width`;
          }
        })} ${validate_component(Range, "Range").$$render(
          $$result,
          {
            min: 1,
            max: 100,
            value: edgeButtonWidthValue
          },
          {
            value: ($$value) => {
              edgeButtonWidthValue = $$value;
              $$settled = false;
            }
          },
          {}
        )}</div></div>`;
      }
    })}`;
  } while (!$$settled);
  $$unsubscribe_settings();
  return $$rendered;
});
const ManageProfilesModal = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let items;
  let $profiles, $$unsubscribe_profiles;
  $$unsubscribe_profiles = subscribe(profiles, (value) => $profiles = value);
  let { open = false } = $$props;
  let newProfile;
  let profileToEdit;
  let newName;
  if ($$props.open === void 0 && $$bindings.open && open !== void 0)
    $$bindings.open(open);
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    items = Object.keys($profiles);
    $$rendered = `${validate_component(Modal, "Modal").$$render(
      $$result,
      { size: "xs", outsideclose: true, open },
      {
        open: ($$value) => {
          open = $$value;
          $$settled = false;
        }
      },
      {
        default: () => {
          return `${validate_component(Listgroup, "Listgroup").$$render($$result, { items }, {}, {
            default: ({ item }) => {
              return `${validate_component(ListgroupItem, "ListgroupItem").$$render(
                $$result,
                {
                  class: "flex flex-row justify-between gap-6"
                },
                {},
                {
                  default: () => {
                    return `<div class="flex-1">${profileToEdit === item ? `<form>${validate_component(Input, "Input").$$render(
                      $$result,
                      {
                        size: "sm",
                        autofocus: true,
                        value: newName
                      },
                      {
                        value: ($$value) => {
                          newName = $$value;
                          $$settled = false;
                        }
                      },
                      {
                        right: () => {
                          return `${validate_component(EditOutline, "EditOutline").$$render(
                            $$result,
                            {
                              slot: "right",
                              size: "sm",
                              class: "hover:text-primary-700"
                            },
                            {},
                            {}
                          )}`;
                        }
                      }
                    )}</form>` : `<p class="line-clamp-1">${escape(item)}</p>`}</div> <div class="flex flex-row gap-2 items-center">${validate_component(CopySolid, "CopySolid").$$render(
                      $$result,
                      {
                        size: "sm",
                        class: "hover:text-primary-700"
                      },
                      {},
                      {}
                    )} ${item !== "Default" ? `${validate_component(UserEditSolid, "UserEditSolid").$$render(
                      $$result,
                      {
                        size: "sm",
                        class: "hover:text-primary-700"
                      },
                      {},
                      {}
                    )} ${validate_component(TrashBinSolid, "TrashBinSolid").$$render(
                      $$result,
                      {
                        size: "sm",
                        class: "hover:text-primary-700"
                      },
                      {},
                      {}
                    )}` : ``}</div>`;
                  }
                }
              )}`;
            }
          })} <form>${validate_component(Input, "Input").$$render(
            $$result,
            {
              type: "text",
              placeholder: "New profile...",
              value: newProfile
            },
            {
              value: ($$value) => {
                newProfile = $$value;
                $$settled = false;
              }
            },
            {
              right: () => {
                return `${validate_component(CirclePlusSolid, "CirclePlusSolid").$$render(
                  $$result,
                  {
                    slot: "right",
                    class: "hover:text-primary-700"
                  },
                  {},
                  {}
                )}`;
              }
            }
          )}</form>`;
        }
      }
    )}`;
  } while (!$$settled);
  $$unsubscribe_profiles();
  return $$rendered;
});
const Profiles = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let items;
  let $currentProfile, $$unsubscribe_currentProfile;
  let $profiles, $$unsubscribe_profiles;
  $$unsubscribe_currentProfile = subscribe(currentProfile, (value) => $currentProfile = value);
  $$unsubscribe_profiles = subscribe(profiles, (value) => $profiles = value);
  let { onClose } = $$props;
  let profile = $currentProfile;
  let files;
  let manageModalOpen = false;
  if ($$props.onClose === void 0 && $$bindings.onClose && onClose !== void 0)
    $$bindings.onClose(onClose);
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    items = Object.keys($profiles).map((id) => {
      return { value: id, name: id };
    });
    $$rendered = `${validate_component(ManageProfilesModal, "ManageProfilesModal").$$render(
      $$result,
      { open: manageModalOpen },
      {
        open: ($$value) => {
          manageModalOpen = $$value;
          $$settled = false;
        }
      },
      {}
    )} ${validate_component(AccordionItem, "AccordionItem").$$render($$result, {}, {}, {
      header: () => {
        return `<span slot="header" data-svelte-h="svelte-1styxdx">Profile</span>`;
      },
      default: () => {
        return `<div class="flex flex-col gap-5"><div class="flex flex-col gap-2">${validate_component(Select, "Select").$$render(
          $$result,
          {
            items,
            placeholder: "Select profile ...",
            value: profile
          },
          {
            value: ($$value) => {
              profile = $$value;
              $$settled = false;
            }
          },
          {}
        )} ${validate_component(Button, "Button").$$render($$result, { size: "sm", outline: true, color: "dark" }, {}, {
          default: () => {
            return `Manage profiles`;
          }
        })}</div> <hr class="border-gray-100 opacity-10"> <div class="flex flex-col gap-2"><input class="border border-slate-700 rounded-lg" type="file" accept=".json"> ${validate_component(Button, "Button").$$render(
          $$result,
          {
            disabled: !files,
            size: "sm",
            outline: true,
            color: "blue"
          },
          {},
          {
            default: () => {
              return `Import profiles`;
            }
          }
        )} ${validate_component(Button, "Button").$$render($$result, { size: "sm", color: "light" }, {}, {
          default: () => {
            return `Export profiles`;
          }
        })}</div></div>`;
      }
    })}`;
  } while (!$$settled);
  $$unsubscribe_currentProfile();
  $$unsubscribe_profiles();
  return $$rendered;
});
const CatalogSettings = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  return `${validate_component(AccordionItem, "AccordionItem").$$render($$result, {}, {}, {
    header: () => {
      return `<span slot="header" data-svelte-h="svelte-fvp27a">Catalog settings</span>`;
    },
    default: () => {
      return `<div class="flex flex-col">${validate_component(Button, "Button").$$render($$result, { outline: true, color: "red" }, {}, {
        default: () => {
          return `Clear catalog`;
        }
      })}</div>`;
    }
  })}`;
});
const Stats = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $totalStats, $$unsubscribe_totalStats;
  $$unsubscribe_totalStats = subscribe(totalStats, (value) => $totalStats = value);
  $$unsubscribe_totalStats();
  return `${validate_component(AccordionItem, "AccordionItem").$$render($$result, {}, {}, {
    header: () => {
      return `<span slot="header" data-svelte-h="svelte-reuttr">Stats</span>`;
    },
    default: () => {
      return `<div><p>Completed volumes: ${escape($totalStats?.completed || 0)}</p> <p>Pages read: ${escape($totalStats?.pagesRead || 0)}</p> <p>Characters read: ${escape($totalStats?.charsRead || 0)}</p> <p>Minutes read: ${escape($totalStats?.minutesRead || 0)}</p></div>`;
    }
  })}`;
});
const VolumeDefaults = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let toggles;
  let $settings, $$unsubscribe_settings;
  $$unsubscribe_settings = subscribe(settings, (value) => $settings = value);
  toggles = [
    {
      key: "rightToLeft",
      text: "Right to left",
      value: $settings.volumeDefaults?.rightToLeft
    },
    {
      key: "singlePageView",
      text: "Single page view",
      value: $settings.volumeDefaults?.singlePageView
    },
    {
      key: "hasCover",
      text: "First page is cover",
      value: $settings.volumeDefaults?.hasCover
    }
  ];
  $$unsubscribe_settings();
  return `${validate_component(AccordionItem, "AccordionItem").$$render($$result, { open: true }, {}, {
    header: () => {
      return `<span slot="header" data-svelte-h="svelte-ir74ki">Volume defaults</span>`;
    },
    default: () => {
      return `<div class="flex flex-col gap-5">${validate_component(Helper, "Helper").$$render($$result, {}, {}, {
        default: () => {
          return `The default settings that are applied when you start a new volume`;
        }
      })} ${each(toggles, ({ key, text, value }) => {
        return `${validate_component(Toggle, "Toggle").$$render($$result, { size: "small", checked: value }, {}, {
          default: () => {
            return `${escape(text)}`;
          }
        })}`;
      })}</div>`;
    }
  })}`;
});
const VolumeSettings = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let settings2;
  let toggles;
  let $$unsubscribe_volumes;
  let $page, $$unsubscribe_page;
  let $volumeSettings, $$unsubscribe_volumeSettings;
  $$unsubscribe_volumes = subscribe(volumes, (value) => value);
  $$unsubscribe_page = subscribe(page, (value) => $page = value);
  $$unsubscribe_volumeSettings = subscribe(volumeSettings, (value) => $volumeSettings = value);
  $page.params.volume;
  settings2 = $volumeSettings[$page.params.volume];
  toggles = [
    {
      key: "rightToLeft",
      text: "Right to left",
      value: settings2.rightToLeft
    },
    {
      key: "singlePageView",
      text: "Single page view",
      value: settings2.singlePageView
    },
    {
      key: "hasCover",
      text: "First page is cover",
      value: settings2.hasCover
    }
  ];
  $$unsubscribe_volumes();
  $$unsubscribe_page();
  $$unsubscribe_volumeSettings();
  return `${validate_component(AccordionItem, "AccordionItem").$$render($$result, { open: true }, {}, {
    header: () => {
      return `<span slot="header" data-svelte-h="svelte-1atib6b">Volume settings</span>`;
    },
    default: () => {
      return `<div class="flex flex-col gap-5">${validate_component(Helper, "Helper").$$render($$result, {}, {}, {
        default: () => {
          return `These settings only apply to this volume`;
        }
      })} ${each(toggles, ({ key, text, value }) => {
        return `${validate_component(Toggle, "Toggle").$$render($$result, { size: "small", checked: value }, {}, {
          default: () => {
            return `${escape(text)}`;
          }
        })}`;
      })}</div>`;
    }
  })}`;
});
const READER_VERSION = "0.9.1";
const About = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  return `${validate_component(AccordionItem, "AccordionItem").$$render($$result, {}, {}, {
    header: () => {
      return `<span slot="header" data-svelte-h="svelte-pk9h3x">About</span>`;
    },
    default: () => {
      return `<div class="flex flex-col gap-5"><div class="flex flex-row justify-between"><p class="font-semibold">Mokuro reader ${escape(READER_VERSION)} ${validate_component(Badge, "Badge").$$render($$result, {}, {}, {
        default: () => {
          return `BETA`;
        }
      })}</p> <a class="hover:text-primary-600" href="https://github.com/ZXY101/mokuro-reader" target="_blank">${validate_component(GithubSolid, "GithubSolid").$$render($$result, {}, {}, {})}</a></div> <p>An online reader, gallery and stat tracker for ${validate_component(A, "A").$$render(
        $$result,
        {
          href: "https://github.com/kha-white/mokuro"
        },
        {},
        {
          default: () => {
            return `mokuro`;
          }
        }
      )} processed manga.</p> <div><p>To use the reader, manga must be processed with mokuro ${validate_component(A, "A").$$render(
        $$result,
        {
          href: "https://github.com/kha-white/mokuro/tree/web-reader"
        },
        {},
        {
          default: () => {
            return `0.2.0-beta.6`;
          }
        }
      )} which can be installed via:</p> <div role="none" data-svelte-h="svelte-1de9tw4"><code class="text-primary-600 bg-slate-900">pip3 install git+https://github.com/kha-white/mokuro.git@web-reader</code></div></div> <p data-svelte-h="svelte-zd08o8">Once processed, upload your manga along with the <span class="text-primary-500">.mokuro</span>
      file.</p> ${validate_component(Helper, "Helper").$$render($$result, {}, {}, {
        default: () => {
          return `Created by ${validate_component(A, "A").$$render($$result, { href: "https://github.com/ZXY101" }, {}, {
            default: () => {
              return `ZXY101`;
            }
          })} &amp; ${validate_component(A, "A").$$render($$result, { href: "https://github.com/kha-white" }, {}, {
            default: () => {
              return `kha-white`;
            }
          })}`;
        }
      })}</div>`;
    }
  })}`;
});
const QuickAccess = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let { hidden = false } = $$props;
  if ($$props.hidden === void 0 && $$bindings.hidden && hidden !== void 0)
    $$bindings.hidden(hidden);
  return `${isReader() ? `<div class="flex flex-col gap-2">${validate_component(Button, "Button").$$render($$result, { color: "alternative" }, {}, {
    default: () => {
      return `Toggle fullscreen`;
    }
  })} ${validate_component(Button, "Button").$$render($$result, { color: "alternative" }, {}, {
    default: () => {
      return `Close reader`;
    }
  })}</div>` : ``}`;
});
const Settings = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let transitionParams = { x: 320, duration: 200, easing: sineIn };
  let { hidden = true } = $$props;
  function onClose() {
    hidden = true;
  }
  beforeNavigate((nav) => {
    if (!hidden) {
      nav.cancel();
      hidden = true;
    }
  });
  if ($$props.hidden === void 0 && $$bindings.hidden && hidden !== void 0)
    $$bindings.hidden(hidden);
  let $$settled;
  let $$rendered;
  do {
    $$settled = true;
    $$rendered = `${validate_component(Drawer, "Drawer").$$render(
      $$result,
      {
        placement: "right",
        transitionType: "fly",
        width: "lg:w-1/4 md:w-1/2 w-full",
        transitionParams,
        id: "settings",
        hidden
      },
      {
        hidden: ($$value) => {
          hidden = $$value;
          $$settled = false;
        }
      },
      {
        default: () => {
          return `<div class="flex items-center"><h5 id="drawer-label" class="inline-flex items-center mb-4 text-base font-semibold">${validate_component(UserSettingsSolid, "UserSettingsSolid").$$render($$result, { class: "w-4 h-4 mr-2.5" }, {}, {})}Settings</h5> ${validate_component(CloseButton, "CloseButton").$$render($$result, { class: "mb-4 dark:text-white" }, {}, {})}</div> <div class="flex flex-col gap-5">${validate_component(Accordion, "Accordion").$$render($$result, { flush: true }, {}, {
            default: () => {
              return `${validate_component(QuickAccess, "QuickAccess").$$render(
                $$result,
                { hidden },
                {
                  hidden: ($$value) => {
                    hidden = $$value;
                    $$settled = false;
                  }
                },
                {}
              )} ${isReader() ? `${validate_component(VolumeSettings, "VolumeSettings").$$render($$result, {}, {}, {})}` : `${validate_component(VolumeDefaults, "VolumeDefaults").$$render($$result, {}, {}, {})}`} ${validate_component(Profiles, "Profiles").$$render($$result, { onClose }, {}, {})} ${validate_component(ReaderSettings, "ReaderSettings").$$render($$result, {}, {}, {})} ${validate_component(AnkiConnectSettings, "AnkiConnectSettings").$$render($$result, {}, {}, {})} ${validate_component(CatalogSettings, "CatalogSettings").$$render($$result, {}, {}, {})} ${validate_component(Stats, "Stats").$$render($$result, {}, {}, {})} ${validate_component(About, "About").$$render($$result, {}, {}, {})}`;
            }
          })} <div class="flex flex-col gap-2">${validate_component(Button, "Button").$$render($$result, { outline: true }, {}, {
            default: () => {
              return `Reset`;
            }
          })} ${validate_component(Button, "Button").$$render($$result, { outline: true, color: "light" }, {}, {
            default: () => {
              return `Close`;
            }
          })}</div></div>`;
        }
      }
    )}`;
  } while (!$$settled);
  return $$rendered;
});
export {
  A,
  CloseButton as C,
  Modal as M,
  Range as R,
  Settings as S,
  Toggle as T,
  UserSettingsSolid as U,
  Accordion as a,
  AccordionItem as b,
  afterNavigate as c,
  clamp as d,
  beforeNavigate as e,
  fade as f,
  fireExstaticEvent as g
};
