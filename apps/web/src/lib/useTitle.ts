import { useEffect } from 'react';

/** 设置浏览器标签页标题（document.title）；title 变化时更新。 */
export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
