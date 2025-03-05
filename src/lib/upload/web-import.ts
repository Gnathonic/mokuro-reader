export function getItems(html: string) {
  const parser = new DOMParser();
  const htmlDoc = parser.parseFromString(html, 'text/html');

  const items = htmlDoc.getElementsByTagName('a');
  return [...items];
}
