// Define main function (script entry)

function main(config, profileName) {

    if (config && config["proxy-groups"])
    {
      for (let group of config["proxy-groups"])
      {
        const regex = /奈飞节点/;
        if (regex.test(group.name))
        {
          if (group.proxies)
          {
            group.proxies.push("🇭🇰 日用 专线 香港 [0.2]");
            group.proxies.push("🇸🇬 日用 专线 狮城 [0.2]");
            group.proxies.push("🇯🇵 日用 专线 日本 [0.2]");
            group.proxies.push("🇺🇸 日用 专线 美国 [0.2]");
          }
        }
      }
    }
  
    return config;
  }
  