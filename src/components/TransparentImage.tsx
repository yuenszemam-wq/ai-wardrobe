import { WardrobeImage, WardrobeImageProps } from './WardrobeImage';
export { hasTransparentPixels } from './WardrobeImage';
export function TransparentImage(props:WardrobeImageProps) { return <WardrobeImage {...props} transparentOnly/>; }
