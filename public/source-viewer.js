(() => {
  const task = new URLSearchParams(location.search).get('task') || '';
  const endpoint = `/api/sessions/${encodeURIComponent(task)}/source`;
  let files = [];
  const render = () => {
    const filter = document.querySelector('#filter').value.toLowerCase();
    const body = document.querySelector('#files');
    body.replaceChildren();
    for (const file of files.filter(file => file.path.toLowerCase().includes(filter))) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const size = document.createElement('td');
      const link = document.createElement('a');
      link.href = `${endpoint}/file?path=${encodeURIComponent(file.path)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = file.path;
      name.appendChild(link);
      size.textContent = file.bytes.toLocaleString();
      row.append(name, size);
      body.appendChild(row);
    }
  };
  document.querySelector('#filter').addEventListener('input', render);
  fetch(`${endpoint}/files`).then(async response => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '源码加载失败');
    files = result.files;
    document.querySelector('#info').textContent = result.commit
      ? `Commit: ${result.commit} · ${files.length} 个文件`
      : '源码将在任务收尾并完成校验后提供。';
    render();
  }).catch(error => { document.querySelector('#info').textContent = error.message; });
})();
