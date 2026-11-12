import { ReactNode, SVGProps } from "react";

/** 線條圖示：全部用 SVG，避免 iPhone 把符號字元（✝、⚙ 等）變成彩色 emoji */
function Svg({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  );
}
type P = SVGProps<SVGSVGElement>;

export const IconHome = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 11 12 4l8.500 7" />
    <path d="M5.500 9.800V20h4.800v-5.200h3.400V20h4.800V9.800" />
  </Svg>
);
export const IconCrown = (p: P) => (
  <Svg {...p}>
    <path d="M4 17.500 3 8l5 4 4-6.500L16 12l5-4-1 9.500z" />
    <path d="M4.500 20.500h15" />
    <circle cx="12" cy="4.300" r=".9" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
/** 穿搭：心形衣領的小裙 */
export const IconDress = (p: P) => (
  <Svg {...p}>
    <path d="M9 3v3.500L7.500 9.500l1.500 2L5 20.500h14l-4-9 1.500-2L15 6.500V3" />
    <path d="M9 6.500c1 1.400 2 1.900 3 1.900s2-.500 3-1.900" />
    <path d="M9 11.500h6" />
  </Svg>
);
export const IconGear = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.200M12 18.800V21M3 12h2.200M18.800 12H21M5.600 5.600l1.600 1.600M16.800 16.800l1.600 1.600M5.600 18.400l1.600-1.600M16.800 7.200l1.600-1.600" />
    <circle cx="12" cy="12" r="6.800" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.500" />
    <path d="m16 16 4.500 4.500" />
  </Svg>
);
export const IconFilter = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h16l-6 7.500V19l-4 1.500v-8z" />
  </Svg>
);
export const IconCloudUp = (p: P) => (
  <Svg {...p}>
    <path d="M7 18.500a4.500 4.500 0 0 1-.600-8.960A5.500 5.500 0 0 1 17.200 9 4.800 4.800 0 0 1 17.500 18.500" />
    <path d="M12 20v-8m-3 2.800 3-3 3 3" />
  </Svg>
);
export const IconHeart = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? "currentColor" : "none"}>
    <path d="M12 20s-7.500-4.600-7.500-10.200A4.300 4.300 0 0 1 12 7.200a4.300 4.300 0 0 1 7.500 2.600C19.500 15.400 12 20 12 20z" />
  </Svg>
);
export const IconUndo = (p: P) => (
  <Svg {...p}>
    <path d="M8 6 4 10l4 4" />
    <path d="M4 10h10a5 5 0 0 1 0 10h-3" />
  </Svg>
);
export const IconRedo = (p: P) => (
  <Svg {...p}>
    <path d="m16 6 4 4-4 4" />
    <path d="M20 10H10a5 5 0 0 0 0 10h3" />
  </Svg>
);
export const IconGrid = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M4 12h16M12 4v16" />
  </Svg>
);
export const IconSave = (p: P) => (
  <Svg {...p}>
    <path d="M5 4h11l3 3v13H5z" />
    <path d="M8 4v5h7V4M8 20v-6h8v6" />
  </Svg>
);
export const IconImage = (p: P) => (
  <Svg {...p}>
    <rect x="3.500" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.500" />
    <path d="m4 17 5-4.500 3.500 3 3-2.500L20 17" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M9.500 7V4.500h5V7M6 7l1 13h10l1-13M10 11v6M14 11v6" />
  </Svg>
);
export const IconLayers = (p: P) => (
  <Svg {...p}>
    <path d="m12 4 8.500 4.500L12 13 3.500 8.500z" />
    <path d="m3.500 12.500 8.500 4.500 8.500-4.500M3.500 16.500 12 21l8.500-4.500" />
  </Svg>
);
export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="m14.500 5-7 7 7 7" />
  </Svg>
);
export const IconSparkle = (p: P) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path d="M12 2c.700 5.200 2.800 7.300 8 8-5.200.700-7.300 2.800-8 8-.700-5.200-2.800-7.300-8-8 5.200-.700 7.300-2.800 8-8z" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);
export const IconPencil = (p: P) => (
  <Svg {...p}>
    <path d="M4 20l1-4.500L16.500 4l3.500 3.500L8.500 19z" />
    <path d="m14 6.500 3.500 3.500" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="m9.500 5 7 7-7 7" />
  </Svg>
);
export const IconChart = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.500a8.500 8.500 0 1 0 8.500 8.500H12z" />
    <path d="M15 3.800A8.500 8.500 0 0 1 20.200 9H15z" />
  </Svg>
);
export const IconMerge = (p: P) => (
  <Svg {...p}>
    <path d="M6 4v4c0 3 6 3 6 7v5M18 4v4c0 3-6 3-6 7" />
    <path d="m9 17 3 3 3-3" />
  </Svg>
);
export const IconCamera = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h3.500L9 5.500h6L16.500 8H20v11H4z" />
    <circle cx="12" cy="13" r="3.500" />
  </Svg>
);
export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
);
export const IconEyeOff = (p: P) => (
  <Svg {...p}>
    <path d="M4 4l16 16M9.6 6A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.7 3.5M6.3 7.8A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 3.4-.7" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);
export const IconChevronUp = (p: P) => (
  <Svg {...p}>
    <path d="M6 15l6-6 6 6" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
export const IconExpand = (p: P) => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);
export const IconPerson = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="7.5" r="3.5" />
    <path d="M5 20.5c.6-4 3.3-6 7-6s6.400 2 7 6" />
  </Svg>
);
export const IconShirt = (p: P) => (
  <Svg {...p}>
    <path d="M8.5 3.5L3 7l2.2 4L7.500 9.800V20.500h9V9.800L18.800 11 21 7l-5.500-3.500a3.500 3.500 0 0 1-7 0z" />
  </Svg>
);
export const IconScissors = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="7" r="2.6" />
    <circle cx="6" cy="17" r="2.6" />
    <path d="M8.200 8.500L20 17M8.200 15.500L20 7" />
  </Svg>
);
export const IconPalette = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.500a8.500 8.500 0 1 0 0 17c1.400 0 2-1 2-2 0-1.500-1-1.800-1-3 0-1 .8-1.800 2-1.800h1.800a3.700 3.700 0 0 0 3.700-3.700C20.500 6.500 16.700 3.500 12 3.500z" />
    <circle cx="7.800" cy="11" r="1" />
    <circle cx="10.500" cy="7.500" r="1" />
    <circle cx="15" cy="7.800" r="1" />
  </Svg>
);
export const IconPose = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="4.500" r="2" />
    <path d="M5 8.500c3 1.500 11 1.500 14 0M12 9.500v5.500M12 15l-3.500 5.500M12 15l3.500 5.500" />
  </Svg>
);
export const IconGrip = (p: P) => (
  <Svg {...p}>
    <path d="M5 8h14M5 12h14M5 16h14" />
  </Svg>
);
export const IconSort = (p: P) => (
  <Svg {...p}>
    <path d="M7 4v16m0 0l-3-3m3 3l3-3M13 6h8M13 11h6M13 16h4" />
  </Svg>
);
export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.3" />
    <circle cx="12" cy="12" r="1.3" />
    <circle cx="19" cy="12" r="1.3" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.500l4.500 4.500L19 7.500" />
  </Svg>
);
