import type { Metadata } from "next";
import StudioClient from "./studio/studio-client";

export const metadata: Metadata = {
  title: "九墨 Jiumo｜水墨音樂可視化工作室",
  description:
    "把你的歌變成一幅會呼吸的水墨。瀏覽器內的開源音樂可視化工作室：自研流體墨韻引擎、GPU 頻譜、墨錦鯉、封面製作、WebCodecs 影片輸出。免安裝、免帳號、純前端。",
};

export default function HomePage() {
  return <StudioClient />;
}
