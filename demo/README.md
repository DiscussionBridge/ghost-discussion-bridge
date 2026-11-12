# Add a DiscussionBridge discussion to a Ghost theme

Use these examples to place a Discourse discussion beside a Ghost article.
Follow the [Ghost setup guide](../docs/INSTALLATION.md) to prepare the loader
URL for your site.

The supplied theme setup recognizes the internal `#discussionbridge` tag on
articles you publish from Ghost and `#discussionbridge-source` on articles
that came from Discourse. Use `#discussionbridge-simple` for inline replies or
`#discussionbridge-full` for the standard Discourse frame. The default is
Interactive.

If your theme uses a custom layout, place a discussion in the article with
the mode you want, then add the loader URL from setup.

```html
<section data-discussionbridge-comments="simple"></section>
```

You can also use `full` or `interactive`. If you have registered a
presentation in DiscussionBridge, use its resource ID.

```html
<article data-discussionbridge-resource="YOUR-RESOURCE-ID"></article>
```

Check the page as a guest and as someone signed into Discourse.
