"use client";

import { useEffect, useState } from "react";

export default function useAdBlockDetection(): boolean {
  const [adBlockDetected, setAdBlockDetected] = useState(false);

  useEffect(() => {
    const checkAdBlock = () => {
      // Create a test element that adblockers typically hide
      const testAd = document.createElement("div");
      testAd.innerHTML = "&nbsp;";
      testAd.className = "adsbox";
      testAd.style.position = "absolute";
      testAd.style.left = "-9999px";
      testAd.style.height = "1px";
      document.body.appendChild(testAd);

      // Check if the element was hidden by adblocker
      setTimeout(() => {
        const isBlocked =
          testAd.offsetHeight === 0 ||
          testAd.style.display === "none" ||
          testAd.style.visibility === "hidden";

        setAdBlockDetected(isBlocked);
        document.body.removeChild(testAd);
      }, 100);
    };

    checkAdBlock();
  }, []);

  return adBlockDetected;
}
