# moltbook.feed

Fetch posts from Moltbook API

```yaml
name: moltbook.feed
description: Fetch posts from Moltbook API
admin_only: false
args:
query: {type: string, description: Search query}
limit: {type: number, description: Max results, default: 5}
sort: {type: string, description: Sort order (hot, new, top), default: hot}
```

```javascript
async def run(args, fetch, log, db, JSON, Date, Math, URL, URLSearchParams):
  query = args.get('query')
  limit = args.get('limit', 5)
  sort = args.get('sort', 'hot')
  
  if not query and sort != 'hot':
    return 'Error: query is required unless sort is 'hot''
  
  url = 'https://moltbook.com/api/feed'
  params = {}
  if query:
    params['q'] = query
  params['limit'] = limit
  params['sort'] = sort
  
  url += '?' + URLSearchParams(params).toString()
  
  try:
    response = await fetch(url, {
      'headers': {
        'Authorization': 'Bearer [MOLTBOOK_API_KEY]'
      }
    })
    
    if not response.ok:
      log(f'Moltbook API error: {response.status} {response.statusText}')
      return f'Moltbook API error: {response.status} {response.statusText}'
    
    data = await response.json()
    return JSON.stringify(data)
  except Exception as e:
    log(f'Error fetching from Moltbook API: {e}')
    return f'Error fetching from Moltbook API: {e}'
```
