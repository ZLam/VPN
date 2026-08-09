export default async function () {
  return {
    type: 'widget',
    url: 'https://www.apple.com/',
    backgroundColor: { light: '#FFFFFF', dark: '#1C1C1E' },
    padding: 16,
    children: [
      {
        type: 'text',
        text: '点击打开 Apple.com',
        font: { size: 16, weight: 'bold' },
        textColor: { light: '#000000', dark: '#FFFFFF' },
        maxLines: 1,
      },
    ],
  };
}
