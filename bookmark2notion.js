const { config } = require('dotenv');
const { login } = require('masto');
const { Client } = require('@notionhq/client');
const { JSDOM } = require('jsdom');
const findIdx = require('lodash/findIndex');

config();
const URL_RE =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/;
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});
const dbID = process.env.BOOKMARK_DATABASE_ID;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function dudu2props(item) {
  let id = item.id; //ID
  let source = item.uri;
  let dom = new JSDOM(item.content.replace(/<br\s*\/>/g, '\n'));
  let links = dom.window.document.querySelectorAll('a');
  links.forEach((li) => {
    let de = li.classList.contains('hashtag') ? '&nbsp;' : '\n';
    li.innerHTML = de + li.textContent + de;
  });
  let content = dom.window.document.body.textContent;
  let lines = content.split('\n');
  content = [];
  lines.forEach((line) => {
    if (!URL_RE.test(line)) {
      if (
        content.length === 0 ||
        (content.length > 0 && content[content.length - 1].type === 'url') ||
        (content.length > 0 &&
          content[content.length - 1].type === 'text' &&
          (content[content.length - 1].text + line).length > 2000) // one block of paragraph max length 2000
      ) {
        content.push({
          type: 'text',
          text: line,
        });
      } else {
        content[content.length - 1].text += '\n' + line;
      }
    } else {
      content.push({
        type: 'url',
        text: line,
      });
    }
  });

  return {
    properties: {
      Name: {
        title: [
          {
            text: {
              content: item.spoilerText || '@' + item.account.username,
            },
          },
        ],
      },
      Source: {
        url: source,
      },
      ID: {
        rich_text: {
          type: 'text', // not using number as the ID is very big number
          text: {
            content: id,
          },
        },
      },
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          text: content.map((i) => {
            if (i.type === 'text') {
              return {
                type: 'text',
                text: {
                  content: i.text,
                },
              };
            } else if (i.type === 'url') {
              return {
                type: 'text',
                text: {
                  content: '\n' + i.text + '\n',
                  link: {
                    url: i.text,
                  },
                },
              };
            }
          }),
        },
      },
    ],
  };
}

async function main() {
  const masto = await login({
    url: process.env.MASTO_URL,
    accessToken: process.env.MASTO_TOKEN,
  });

  let sorted = await notion.databases.query({
    database_id: dbID,
    sorts: [
      {
        property: 'Created',
        direction: 'descending',
      },
    ],
    page_size: 1,
  });
  let last = sorted.results?.[0].properties.ID.rich_text[0].plain_text || null;

  let bookmarks = [];
  let gen = await masto.bookmarks.getIterator({ limit: 50 });

  if (last) {
    let idx = null;
    while (idx === -1 || idx === null) {
      let { value } = await gen.next();
      idx = findIdx(value, (v) => v.id === last);
      if (idx > 0) { // no need to fetch more
        bookmarks.push(...value.slice(0, idx));
        console.log('Fetched', bookmarks.length, 'bookmarks.');
        break;
      } else if (idx === 0) { // no new item
        break;
      } // else: index == -1, need to fetch more
      await sleep('500');
    }
    if (bookmarks.length) {
      console.log('New', bookmarks.length, 'bookmarks to be inserted.');
    } else {
      console.log('No new bookmarks.');
      return;
    }

  } else { // no last means the notion db is blank now, need to fetch all bookmarks
    let done = false;
    while (!done) {
      let res = await gen.next();
      done = res.done;
      if (done) {
        break;
      }
      if (res.value) {
        bookmarks.push(...res.value);
        console.log('Fetched', bookmarks.length, 'bookmarks.');
        await sleep('500');
      }
    }
  }

  bookmarks = bookmarks.reverse(); // order in mastodon API is reversed by time, last in, last out
  for (let i = 0; i < bookmarks.length; i++) {
    const item = bookmarks[i];
    try {
      const postData = {
        parent: {
          database_id: dbID,
        },
        ...dudu2props(item),
      };
      const response = await notion.pages.create(postData);
      await sleep('200');
      if (response && response.id) {
        console.log(item.url, ' page created (id=', item.id, ')');
      }
    } catch (error) {
      console.warn('Failed to create the page for ', item.url, '(id=', item.id, ')');
    }
  }
}

main();
