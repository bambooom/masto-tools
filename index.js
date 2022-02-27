const { config } = require('dotenv');
const { login } = require('masto');
const { Client } = require('@notionhq/client');
const { JSDOM } = require('jsdom');

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

// a is after b
function isAfter(a, b) {
  return new Date(a).getTime() > new Date(b).getTime();
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
  let last = sorted.results[0].created_time;
  console.log(sorted.results[0]);
  // console.log(sorted.results[0].created_time); // '2022-02-26T11:22:00.000Z',

  const bookmarks = [];
  let gen = await masto.bookmarks.getIterator({ limit: 50 });
  let { value } = await gen.next();
  // '2022-02-21T20:05:45.247Z'
  console.log(value[0].createdAt);
  console.log(last);
  console.log(isAfter(last, value[0].createdAt));
  // 不能用 createdAt 来作为新的判断标准，这个时间是原嘟文创建的时间，并不是你添加到 bookmark 的时间，还是只能用 ID 来判断
  if (isAfter(last, value[0].createdAt)) {
    // no new bookmarks
    console.log('All bookmarks imported.');
    return;
  } else if (isAfter(last, value[value.length - 1].createdAt)) {
    // has new bookmarks, but no more than 40(limit)
    bookmarks.push(...value.filter((item) => isAfter(item.createdAt, last)));
  } else {
    // has more bookmarks not imported
    bookmarks.push(...value);
    while (isAfter(value[value.length - 1].createdAt, last)) {
      let res = await gen.next();
      if (res.done) {
        break;
      }
      value = res.value;
      if (value) {
        bookmarks.push(
          ...value.filter((item) => isAfter(item.createdAt, last))
        );
        console.log('Fetched ', bookmarks.length, ' bookmarks.');
        await sleep('500');
      }
    }
  }

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
        console.log(item.url, ' page created.');
      }
    } catch (error) {
      console.warn('Failed to create the page for ', item.url);
    }
  }
}

main();
