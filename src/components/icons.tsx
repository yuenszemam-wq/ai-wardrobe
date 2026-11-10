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
