# facebook.browse

Navigate Facebook like a human - scroll feed, like posts, comment, share. Uses computer vision to interact with the Facebook UI naturally.

```yaml
name: facebook.browse
description: Navigate Facebook like a human - scroll feed, like posts, comment, share. Uses computer vision to interact with the Facebook UI naturally.
admin_only: false
args:
action: string # scroll_feed, like_post, comment, create_post, check_notifications, go_to_profile, go_to_groups
text: string # optional - text for comment or post
chatId: string # telegram chat ID for screenshots
count: number # optional - number of posts to scroll/like (default 5)
```

```javascript
const { action = 'scroll_feed', text = '', chatId = '8189338836', count = 5 } = args;

const FACEBOOK_URL = 'https://www.facebook.com';

async function ensureFacebookOpen() {
  const status = await ctx.run('browser.status', {});
  const currentUrl = status?.url || '';
  if (!currentUrl.includes('facebook.com')) {
    await ctx.run('browser.navigate', { url: FACEBOOK_URL, screenshot: 'yes', chatId });
    await ctx.run('browser.wait', { delay: '3000' });
  }
}

try {
  switch (action) {
    case 'scroll_feed': {
      await ensureFacebookOpen();
      const results = [];
      for (let i = 0; i < count; i++) {
        await ctx.run('browser.scroll', { direction: 'down', amount: '500' });
        await ctx.run('browser.wait', { delay: '2000' });
      }
      await ctx.run('browser.screenshot', { chatId });
      return `Scrolled ${count} times through Facebook feed. Screenshot sent.`;
    }
    
    case 'like_post': {
      await ensureFacebookOpen();
      // Use computer.use for intelligent interaction
      const result = await ctx.run('computer.use', {
        goal: 'Find the most recent post in the Facebook news feed and click the Like button on it',
        app: 'browser',
        chatId,
        maxSteps: '5',
        quiet: 'false'
      });
      return `Like action completed: ${JSON.stringify(result).slice(0, 300)}`;
    }
    
    case 'comment': {
      if (!text) return 'Error: text is required for commenting';
      await ensureFacebookOpen();
      const result = await ctx.run('computer.use', {
        goal: `Find the most recent post in the Facebook feed, click the Comment button, type this comment: "${text}", then press Enter to submit`,
        app: 'browser',
        chatId,
        maxSteps: '8',
        quiet: 'false'
      });
      return `Comment posted: "${text}" - ${JSON.stringify(result).slice(0, 300)}`;
    }
    
    case 'create_post': {
      if (!text) return 'Error: text is required for creating a post';
      await ensureFacebookOpen();
      const result = await ctx.run('computer.use', {
        goal: `Click on the "What's on your mind" box at the top of the Facebook feed, type this text: "${text}", then click the Post button to publish it`,
        app: 'browser',
        chatId,
        maxSteps: '10',
        quiet: 'false'
      });
      return `Post created: "${text.slice(0, 100)}..." - ${JSON.stringify(result).slice(0, 300)}`;
    }
    
    case 'check_notifications': {
      await ensureFacebookOpen();
      const result = await ctx.run('computer.use', {
        goal: 'Click the notifications bell icon on Facebook and read the latest 5 notifications',
        app: 'browser',
        chatId,
        maxSteps: '5',
        quiet: 'false'
      });
      return `Notifications: ${JSON.stringify(result).slice(0, 500)}`;
    }
    
    case 'go_to_profile': {
      await ensureFacebookOpen();
      const result = await ctx.run('computer.use', {
        goal: 'Click on my profile picture or name in the Facebook sidebar/header to go to my own profile page',
        app: 'browser',
        chatId,
        maxSteps: '5',
        quiet: 'false'
      });
      return `Navigated to profile: ${JSON.stringify(result).slice(0, 300)}`;
    }
    
    case 'go_to_groups': {
      await ensureFacebookOpen();
      const result = await ctx.run('computer.use', {
        goal: 'Click on Groups in the Facebook left sidebar to see all groups',
        app: 'browser',
        chatId,
        maxSteps: '5',
        quiet: 'false'
      });
      return `Navigated to groups: ${JSON.stringify(result).slice(0, 300)}`;
    }
    
    default:
      return `Unknown action: ${action}. Available: scroll_feed, like_post, comment, create_post, check_notifications, go_to_profile, go_to_groups`;
  }
} catch (err) {
  return `Facebook browse error: ${err.message}`;
}
```
