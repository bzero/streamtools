$(function() {

    // before anything, we need to load the library.
    var library = JSON.parse($.ajax({
        url: '/library',
        type: 'GET',
        async: false // required before UI stream starts
    }).responseText);

    var domain = JSON.parse($.ajax({
        url: '/domain',
        type: 'GET',
        async: false // required before UI stream starts
    }).responseText).Domain;

    var port = JSON.parse($.ajax({
        url: '/port',
        type: 'GET',
        async: false // required before UI stream starts
    }).responseText).Port;

    var version = JSON.parse($.ajax({
        url: '/version',
        type: 'GET',
        async: false // required before UI stream starts
    }).responseText).Version;

    // constants
    var DELETE = 8,
        BACKSPACE = 46,
        ROUTE = 10,
        HALF_ROUTE = ROUTE * 0.5,
        ROUTE_SPACE = ROUTE * 1.5,
        CONN_OFFSET = 15,
        TIP_OFF = {
            x: 10,
            y: -10,
        },
        RECONNECT_WAIT = 3000,
        LOG_LIMIT = 100;

    var blocks = [], // canonical block data for d3
        connections = [], // canonical connection data for d3
        width = window.innerWidth,
        height = window.innerHeight,
        mouse = {
            x: 0,
            y: 0
        },
        multiSelect = false, // shift click state
        isConnecting = false, // connecting state
        newConn = {}, // connecting state data
        log = new logReader(),
        ui = new uiReader();

    var controllerTemplate = $('#controller-template').html();

    var libraryHound = new Bloodhound({
        datumTokenizer: function(d) {
            return Bloodhound.tokenizers.whitespace(d.key);
        },
        queryTokenizer: Bloodhound.tokenizers.whitespace,
        local: d3.entries(library)
    });

    libraryHound.initialize();

    $('#create-input').typeahead(null, {
        displayKey: 'key',
        source: libraryHound.ttAdapter()
    });

    //
    // SVG elements
    //

    var svg = d3.select('body').append('svg')
        .attr('width', width)
        .attr('height', height);

    // workspace background
    var bg = svg.append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('class', 'background')
        .attr('width', width)
        .attr('height', height)
        .on('dblclick', function() {
            $('#create')
                .css({
                    top: mouse.y,
                    left: mouse.x,
                    'visibility': 'visible'
                });
            $('#create-input').focus();
        })
        .on('click', function() {
            if (isConnecting) {
                terminateConnection();
            }
        })
        .on('mousedown', function() {
            d3.selectAll('.selected')
                .classed('selected', false);
        });

    // contains all connection ui
    var linkContainer = svg.append('g')
        .attr('class', 'linkContainer');

    // contains all node ui
    var nodeContainer = svg.append('g')
        .attr('class', 'nodeContainer');

    var controlContainer = d3.select('body').append('div')
        .attr('class', 'controlContainer')

    var link = linkContainer.selectAll('.link'),
        node = nodeContainer.selectAll('.node'),
        control = controlContainer.selectAll('.controller');

    var tooltip = d3.select('body')
        .append('div')
        .attr('class', 'tooltip');

    var drag = d3.behavior.drag()
        .on('dragstart', function(d, i) {
            d3.event.sourceEvent.stopPropagation();
            d3.event.sourceEvent.preventDefault();
        })
        .on('drag', function(d, i) {
            d.Position.X += d3.event.dx;
            d.Position.Y += d3.event.dy;
            d3.select(this)
                .attr('transform', function(d, i) {
                    return 'translate(' + [d.Position.X, d.Position.Y] + ')';
                });
            updateLinks();
        })
        .on('dragend', function(d, i) {
            // need to tell daemon that this block has updated position
            // so that we can save it and share across clients
            $.ajax({
                url: '/blocks/' + d.Id,
                type: 'PUT',
                data: JSON.stringify(d.Position),
                success: function(result) {}
            });
        });

    var dragTitle = d3.behavior.drag()
        .on('dragstart', function(d, i) {
            d3.event.sourceEvent.stopPropagation();
            d3.event.sourceEvent.preventDefault();
        })
        .on('drag', function(d, i) {
            var pos = $(this.parentNode).offset();

            $(this.parentNode).offset({
                left: pos.left + mouse.dx,
                top: pos.top + mouse.dy
            });
        });

    var dragRate = d3.behavior.drag()
        .on('dragstart', function(d, i) {
            d3.event.sourceEvent.stopPropagation();
            d3.event.sourceEvent.preventDefault();
            d.drag = {
                x: mouse.x,
                y: mouse.y
            }
        })
        .on('dragend', function(d, i) {
            if (Math.pow((mouse.x - d.drag.x), 2) + Math.pow((mouse.y - d.drag.y), 2) > 20) {
                $.get('connections/' + d.Id + '/last', function(resp) {
                    createStaticPanel(d.Id + '/last', JSON.stringify(resp.Last, null, 4))
                })
            }
        });


    var resize = d3.behavior.drag()
        .on('dragstart', function(d, i) {
            d3.event.sourceEvent.stopPropagation();
            d3.event.sourceEvent.preventDefault();
        })
        .on('drag', function(d, i) {
            var controller = $('[data-id=_' + d.Id + ']');
            controller.width(controller.width() + d3.event.dx);
            controller.height(controller.height() + d3.event.dy);
        });

    // ui element for new connection
    var newConnection = svg.select('.linkcontainer').append('path')
        .attr('id', 'newLink')
        .style('fill', 'none')
        .on('click', function() {
            if (isConnecting) {
                terminateConnection();
            }
        });

    // so we have a cool angled look
    var lineStyle = d3.svg.line()
        .x(function(d) {
            return d.x;
        })
        .y(function(d) {
            return d.y;
        })
        .interpolate('monotone');

    //
    // GLOBAL EVENTS
    //

    $(window).mousemove(function(e) {
        mouse = {
            x: e.clientX,
            dx: e.clientX - mouse.x,
            y: e.clientY,
            dy: e.clientY - mouse.y,
        };

        if (isConnecting) {
            updateNewConnection();
        }
    });

    $(window).keydown(function(e) {
        // check to see if any text box is selected
        // if so, don't allow multiselect
        if ($('input').is(':focus') || $('textarea').is(':focus')) {
            return;
        }

        // if key is backspace or delete
        if (e.keyCode == DELETE || e.keyCode == BACKSPACE) {
            e.preventDefault();
            d3.selectAll('.selected')
                .each(function(d) {
                    if (this.classList.contains('idrect')) {
                        $.ajax({
                            url: '/blocks/' + d3.select(this.parentNode).datum().Id,
                            type: 'DELETE',
                            success: function(result) {}
                        });
                    }
                    if (this.classList.contains('rateLabel')) {
                        $.ajax({
                            url: '/connections/' + d3.select(this).datum().Id,
                            type: 'DELETE',
                            success: function(result) {}
                        });
                    }
                });
        }

        multiSelect = e.shiftKey;
    });

    $(window).keyup(function(e) {
        multiSelect = e.shiftKey;
    });

    $(window).smartresize(function(e) {
        svg.attr('width', window.innerWidth)
            .attr('height', window.innerHeight);
        bg.attr('width', window.innerWidth)
            .attr('height', window.innerHeight);
    });

    $('#create-input').focusout(function() {
        $('#create-input').typeahead('val', '');
        $('#create').css({
            'visibility': 'hidden'
        });
    });

    $('#create-input').keyup(function(k) {
        if (k.keyCode == 13) {
            createBlock();
            $('#create').css({
                'visibility': 'hidden'
            });
            $('#create-input').typeahead('val', '');
        }
    });

    $('#log').click(function() {
        if ($(this).hasClass('log-max')) {
            $(this).removeClass('log-max');
            var log = document.getElementById('log');
            log.scrollTop = log.scrollHeight;
        } else {
            $(this).addClass('log-max');
        }
    });

    function createStaticPanel(titleTxt, data) {
        var info = d3.select('body').append('div')
            .classed('info-panel', true)
            .style('top', mouse.y + 'px')
            .style('left', mouse.x + 'px')
            .style('display', 'block')

        var title = info.append('div')
            .classed('title', true)
            .call(dragTitle);

        title.append('div')
            .classed('name', true)
            .text(titleTxt);

        title.append('div')
            .classed('close', true)
            .html('&#215;')
            .on('click', function(d) {
                $(this).parent().parent().remove();
            });

        body = info.append('div')
            .classed('body', true);

        body.append('textarea')
            .classed('info-text', true)
            .text(data);
    }


    function pauseEvent(e) {
        if (e.stopPropagation) e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
        e.cancelBubble = true;
        e.returnValue = false;
        return false;
    }

    function createBlock() {
        var blockType = $('#create-input').val();
        if (!library.hasOwnProperty(blockType)) {
            return;
        }
        // we use an offset so that if the user moves the mouse during
        // id entry, we spawn a block where the dialog is located
        var offset = $('#create').offset();
        $.ajax({
            url: '/blocks',
            type: 'POST',
            data: JSON.stringify({
                'Type': blockType,
                'Position': {
                    'X': offset.left,
                    'Y': offset.top
                }
            }),
            success: function(result) {}
        });
    }

    function logPush(tmpl) {
        var logItem = $('<div />').addClass('log-item');
        $('#log').append(logItem);
        logItem.html(tmpl);

        var log = document.getElementById('log');
        log.scrollTop = log.scrollHeight;

        if ($('#log').children().length > LOG_LIMIT) {
            $('#log').children().eq(0).remove();
        }
    }

    function uiReconnect() {
        var logTemplate = $('#ui-log-item-template').html();
        var tmpl = _.template(logTemplate, {
            item: {
                data: "lost connection to Streamtools. Retrying..."
            }
        });
        logPush(tmpl);

        disconnected();
        if (ui.ws.readyState == 3) {
            window.setTimeout(function() {
                ui = new uiReader();
                uiReconnect();
            }, RECONNECT_WAIT);
        }
    }

    function logReconnect() {
        disconnected();
        if (log.ws.readyState == 3) {
            window.setTimeout(function() {
                log = new logReader();
                logReconnect();
            }, RECONNECT_WAIT);
        }
    }

    function disconnected() {
        blocks.length = 0;
        connections.length = 0;
        isConnecting = false;
        newConn = {};
        update();
    }

    function logReader() {
        var logTemplate = $('#log-item-template').html();
        this.ws = new WebSocket('ws://' + domain + ':' + port + '/log');

        this.ws.onmessage = function(d) {
            var logData = JSON.parse(d.data);
            for (var i = 0; i < logData.Log.length; i++) {
                var tmpl = _.template(logTemplate, {
                    item: {
                        type: logData.Log[i].Type,
                        time: new Date(),
                        data: JSON.stringify(logData.Log[i].Data),
                        id: logData.Log[i].Id,
                    }
                });
                logPush(tmpl);

                if (logData.Log[i].Type == 'ERROR') {
                    var logItem = logData.Log[i].Id
                    d3.select('.idrect[data-id=_' + logItem + ']')
                        .classed('errored', true);

                    setTimeout(function() {
                        d3.select('.idrect[data-id=_' + logItem + ']')
                            .classed('errored', false);
                    }, 500);
                }
            }
        };
        this.ws.onclose = logReconnect;
    }

    function uiReader() {
        _this = this;
        _this.handleMsg = null;
        this.ws = new WebSocket('ws://' + domain + ':' + port + '/ui');
        this.ws.onopen = function(d) {
            var logTemplate = $('#ui-log-item-template').html();
            var tmpl = _.template(logTemplate, {
                item: {
                    data: "connected to Streamtools " + version
                }
            });
            logPush(tmpl);
            setTimeout(function() {
                _this.ws.send(JSON.stringify({
                    "action": "export"
                }));
            }, 1000);
        };
        this.ws.onclose = uiReconnect;
        this.ws.onmessage = function(d) {
            var uiMsg = JSON.parse(d.data);
            var isBlock = uiMsg.Data.hasOwnProperty('Type');

            switch (uiMsg.Type) {
                case 'RULE_UPDATED':
                    if (d3.select('.idrect[data-id=_' + uiMsg.Id + ']')[0][0] == null) {
                        break;
                    }
                    if (d3.select('.idrect[data-id=_' + uiMsg.Id + ']').classed('updated') == false) {
                        d3.select('.idrect[data-id=_' + uiMsg.Id + ']')
                            .classed('updated', true);

                        setTimeout(function() {
                            d3.select('.idrect[data-id=_' + uiMsg.Id + ']')
                                .classed('updated', false);
                        }, 200)
                    }

                    _this.ws.send(JSON.stringify({
                        "action": "rule",
                        "id": uiMsg.Id
                    }));
                    break;
                case 'CREATE':
                    if (isBlock) {
                        // we need to get typeinfo from the library
                        // so that we can load the correct route information
                        // for that block type
                        library[uiMsg.Data.Type].InRoutes.sort();
                        uiMsg.Data.TypeInfo = library[uiMsg.Data.Type];
                        blocks.push(uiMsg.Data);
                        update();
                        // we need to update the rule controller for the block.
                        d3.select('.controller[data-id=_' + uiMsg.Data.Id + ']')[0][0].refresh();
                    } else {
                        connections.push(uiMsg.Data);
                        update();
                    }

                    break;
                case 'DELETE':
                    for (var i = 0; i < blocks.length; i++) {
                        if (uiMsg.Data.Id == blocks[i].Id) {
                            blocks.splice(i, 1);
                            break;
                        }
                    }
                    for (var i = 0; i < connections.length; i++) {
                        if (uiMsg.Data.Id == connections[i].Id) {
                            connections.splice(i, 1);
                            break;
                        }
                    }
                    update();
                    break;
                case 'UPDATE_RULE':
                    var block = null;
                    for (var i = 0; i < blocks.length; i++) {
                        if (blocks[i].Id === uiMsg.Data.Id) {
                            block = blocks[i];
                            break;
                        }
                    }
                    if (block !== null) {
                        block.Rule = uiMsg.Data.Rule;
                        d3.select('.controller[data-id=_' + block.Id + ']')[0][0].refresh();
                    }
                    break;
                case 'UPDATE_RATE':
                    var conn = null;
                    for (var i = 0; i < connections.length; i++) {
                        if (connections[i].Id == uiMsg.Id) {
                            conn = connections[i];
                            break;
                        }
                    }
                    if (conn !== null) {
                        conn.rate = uiMsg.Data.Rate;
                    }
                    break;
                case 'UPDATE_POSITION':
                    var block = null;
                    for (var i = 0; i < blocks.length; i++) {
                        if (blocks[i].Id === uiMsg.Data.Id) {
                            block = blocks[i];
                            break;
                        }
                    }
                    if (block !== null) {
                        block.Position = uiMsg.Data.Position;
                        update();
                        updateLinks();
                    }
                    break;
                case 'UPDATE':
                case 'QUERY':
                    break;
            }
        };
    }

    function update() {
        control = control.data(blocks, function(d) {
            return d.Id;
        });

        var controls = control.enter().append('div')
            .classed('controller', true)
            .attr('data-id', function(d) {
                return '_' + d.Id;
            });

        var titles = controls.append('div')
            .classed('title', true)
            .call(dragTitle);

        titles.append('div')
            .classed('name', true)
            .html(function(d) {
                return d.Id + ' (' + d.Type + ')';
            });

        titles.append('div')
            .classed('close', true)
            .html('&#215;')
            .on('click', function(d) {
                // hide the block controller when X is clicked.
                $(this).parent().parent().css({
                    'display': 'none'
                });
            });

        var bodies = controls.append('div')
            .classed('body', true)
            .each(function(d) {
                this.refresh = function() {
                    d3.select(this).select('.body').html(_.template(controllerTemplate, {
                        data: {
                            Id: d.Id,
                            Type: d.Type,
                            Rule: d.Rule,
                        }
                    }));
                };
            });

        var bottoms = controls.append('div')
            .classed('bottom', true)

        bottoms.append('div')
            .classed('update', true)
            .text('update')
            .on('click', function(d) {
                var rule = {};
                for (var key in d.Rule) {
                    var ruleInput = $('#c_' + d.Id + "_" + key);
                    var val = ruleInput.val();
                    var type = ruleInput.attr("data-type");
                    switch (type) {
                        case 'boolean':
                            rule[key] = val === 'true' ? true : false;
                            break;
                        case 'string':
                            rule[key] = val;
                            break;
                        case 'object':
                            rule[key] = JSON.parse(val);
                            break;
                        case 'number':
                            rule[key] = parseFloat(val);
                            break;
                    }
                }
                $.ajax({
                    url: '/blocks/' + d.Id + '/rule',
                    type: 'POST',
                    data: JSON.stringify(rule),
                    success: function(result) {}
                });
            });

        bottoms.append('div')
            .classed('handle', true)
            .call(resize);

        controls.each(function(d) {
            this.refresh = d3.select(this).select('.body')[0][0].refresh;
        });

        control.exit().remove();

        node = node.data(blocks, function(d) {
            return d.Id;
        });

        var nodes = node.enter()
            .append('g')
            .attr('class', 'node')
            .call(drag);

        var idRects = nodes.append('rect')
            .attr('class', 'idrect')
            .attr('data-id', function(d) {
                return '_' + d.Id;
            });

        nodes.append('svg:text')
            .attr('class', 'nodetype unselectable')
            .attr('dx', 0)
            .text(function(d) {
                return d.Type;
            }).each(function(d) {
                var bbox = this.getBBox();
                d.width = (d.TypeInfo.InRoutes.length * ROUTE + d.TypeInfo.InRoutes.length * ROUTE_SPACE)
                d.width = (d.width > bbox.width ? d.width : bbox.width + 30);
                d.height = (d.height > bbox.height ? d.height : bbox.height + 5);
            }).attr('dy', function(d) {
                return 1 * d.height + 5;
            })
            .on('mousedown', function() {
                if (!multiSelect) {
                    d3.selectAll('.selected')
                        .classed('selected', false);
                }
                d3.select(this.parentNode).select('.idrect')
                    .classed('selected', true);
            })
            .on('dblclick', function(d) {
                d3.select('.controller[data-id=_' + d.Id + ']')
                    .style('display', 'block')
                    .style('top', function(d) {
                        return d.Position.Y;
                    })
                    .style('left', function(d) {
                        return d.Position.X + d.width + 10;
                    })
            });

        // the click events for nodes and idRects are exactly the same
        // and should not be duplicated in future versions.
        // both of them allow selection on single click and the opening
        // of the contoller on a double cick. 

        idRects
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', function(d) {
                return d.width;
            })
            .attr('height', function(d) {
                return d.height * 2;
            })
            .on('mousedown', function() {
                if (!multiSelect) {
                    d3.selectAll('.selected')
                        .classed('selected', false);
                }
                d3.select(this)
                    .classed('selected', true);
            })
            .on('dblclick', function(d) {
                d3.select('.controller[data-id=_' + d.Id + ']')
                    .style('display', 'block')
                    .style('top', function(d) {
                        return d.Position.Y;
                    })
                    .style('left', function(d) {
                        return d.Position.X + d.width + 10;
                    })
            });

        node.attr('transform', function(d) {
            return 'translate(' + d.Position.X + ', ' + d.Position.Y + ')';
        });

        var inRoutes = node.selectAll('.in')
            .data(function(d) {
                return d.TypeInfo.InRoutes;
            });

        inRoutes.enter()
            .append('rect')
            .attr('class', 'chan in')
            .attr('x', function(d, i) {
                return i * ROUTE_SPACE;
            })
            .attr('y', 0)
            .attr('width', ROUTE)
            .attr('height', ROUTE)
            .on('mouseover', function(d) {
                tooltip.text(d);
                return tooltip.style('visibility', 'visible');
            })
            .on('mousemove', function(d) {
                return tooltip.style('top', (event.pageY + TIP_OFF.y) + 'px').style('left', (event.pageX + TIP_OFF.x) + 'px');
            })
            .on('mouseout', function(d) {
                return tooltip.style('visibility', 'hidden');
            }).on('click', function(d) {
                handleConnection(d3.select(this.parentNode).datum(), d, 'in');
            });

        inRoutes.exit().remove();

        var queryRoutes = node.selectAll('.query')
            .data(function(d) {
                return d.TypeInfo.QueryRoutes;
            });

        queryRoutes.enter()
            .append('rect')
            .attr('class', 'chan query')
            .attr('x', function(d, i) {
                var p = d3.select(this.parentNode).datum();
                return (p.width - ROUTE);
            })
            .attr('y', function(d, i) {
                return i * ROUTE_SPACE;
            })
            .attr('width', ROUTE)
            .attr('height', ROUTE)
            .on('mouseover', function(d) {
                tooltip.text(d);
                return tooltip.style('visibility', 'visible');
            })
            .on('mousemove', function(d) {
                return tooltip.style('top', (event.pageY + TIP_OFF.y) + 'px').style('left', (event.pageX + TIP_OFF.x) + 'px');
            })
            .on('mouseout', function(d) {
                return tooltip.style('visibility', 'hidden');
            })
            .on('click', function(d) {
                var p = d3.select(this.parentNode).datum()
                $.get('blocks/' + p.Id + '/' + d, function(resp) {
                    createStaticPanel(p.Id + '/' + d, JSON.stringify(resp, null, 4))
                })
            });

        queryRoutes.exit().remove();

        var outRoutes = node.selectAll('.out')
            .data(function(d) {
                return d.TypeInfo.OutRoutes;
            });

        outRoutes.enter()
            .append('rect')
            .attr('class', 'chan out')
            .attr('x', function(d, i) {
                return i * ROUTE_SPACE;
            })
            .attr('y', function(d, i) {
                var p = d3.select(this.parentNode).datum();
                return ((p.height * 2) - ROUTE);
            })
            .attr('width', ROUTE)
            .attr('height', ROUTE)
            .on('mouseover', function(d) {
                tooltip.text(d);
                return tooltip.style('visibility', 'visible');
            })
            .on('mousemove', function(d) {
                return tooltip.style('top', (event.pageY + TIP_OFF.y) + 'px').style('left', (event.pageX + TIP_OFF.x) + 'px');
            })
            .on('mouseout', function(d) {
                return tooltip.style('visibility', 'hidden');
            }).on('click', function(d) {
                handleConnection(d3.select(this.parentNode).datum(), d, 'out');
            });

        outRoutes.exit().remove();

        node.exit().remove();

        link = link.data(connections, function(d) {
            return d.Id;
        });

        link.enter()
            .append('svg:path')
            .attr('class', 'link')
            .style('fill', 'none')
            .attr('id', function(d) {
                return 'link_' + d.Id;
            })
            .each(function(d) {
                d.path = d3.select(this)[0][0];
                d.from = node.filter(function(p, i) {
                    return p.Id == d.FromId;
                }).datum();
                d.to = node.filter(function(p, i) {
                    return p.Id == d.ToId;
                }).datum();
                d.rate = 0.00;
                d.rateLoc = 0.0;
            });

        var ping = svg.select('.linkContainer').selectAll('.edgePing')
            .data(connections, function(d) {
                return d.Id;
            });

        ping.enter()
            .append('circle')
            .attr('class', 'edgePing')
            .attr('r', 4);

        ping.exit().remove();

        var edgeLabel = svg.select('.linkContainer').selectAll('.edgeLabel')
            .data(connections, function(d) {
                return d.Id;
            })

        var ed = edgeLabel.enter()
            .append('g')
            .attr('class', 'edgeLabel')
            .append('text')
            .attr('dy', -2)
            .attr('text-anchor', 'middle')
            .append('textPath')
            .attr('class', 'rateLabel unselectable')
            .attr('startOffset', '50%')
            .attr('xlink:href', function(d) {
                return '#link_' + d.Id;
            })
            .text(function(d) {
                return d.rate;
            })
            .on('mousedown', function() {
                if (!multiSelect) {
                    d3.selectAll('.selected')
                        .classed('selected', false);
                }
                d3.select(this)
                    .classed('selected', true);
            })
            .call(dragRate)

        edgeLabel.exit().remove();

        updateLinks();
        link.exit().remove();
    }

    // update rate label every x ms
    window.setInterval(function() {
        d3.selectAll('.rateLabel')
            .text(function(d) {
                // this is dumb.
                // d.rate = Math.sin(+new Date() * .0000001) * Math.random() * 5;
                return Math.round(d.rate * 100) / 100.0;
            });
    }, 100);

    // keep the rate balls moving
    updatePings();

    function updatePings() {
        svg.selectAll('.edgePing')
            .each(function(d) {
                //d.rate += Math.random();
                d.rateLoc += 0.001 + Math.min(d.rate, 100) / 4000.0;
                if (d.rateLoc > 1) d.rateLoc = 0;
                d.edgePos = d.path.getPointAtLength(d.rateLoc * d.path.getTotalLength());
            })
            .attr('cx', function(d) {
                return d.edgePos.x;
            })
            .attr('cy', function(d) {
                return d.edgePos.y;
            });
        requestAnimationFrame(updatePings);
    }

    // updateLinks() is too slow!
    // generates paths fo all links
    function updateLinks() {
        link.attr('d', function(d) {
            return lineStyle([{
                x: d.from.Position.X + HALF_ROUTE,
                y: (d.from.Position.Y + d.from.height * 2) - HALF_ROUTE
            }, {
                x: d.from.Position.X + HALF_ROUTE,
                y: (d.from.Position.Y + d.from.height * 2) + ROUTE_SPACE
            }, {
                x: d.to.Position.X + (d.to.TypeInfo.InRoutes.indexOf(d.ToRoute) * ROUTE_SPACE) + HALF_ROUTE,
                y: d.to.Position.Y - ROUTE_SPACE
            }, {
                x: d.to.Position.X + (d.to.TypeInfo.InRoutes.indexOf(d.ToRoute) * ROUTE_SPACE) + HALF_ROUTE,
                y: d.to.Position.Y + HALF_ROUTE
            }]);
        });
    }

    function handleConnection(block, route, routeType) {
        isConnecting = !isConnecting;
        isConnecting ? startConnection(block, route, routeType) : endConnection(block, route, routeType);
    }

    function startConnection(block, route, routeType) {
        newConn = {
            start: block,
            startRoute: route,
            startType: routeType
        };
        updateNewConnection();
        newConnection.style('visibility', 'visible');
    }

    function endConnection(block, route, routeType) {
        if (newConn.startType === routeType) {
            return;
        }

        var connReq = {
            'FromId': null,
            'ToId': null,
            'ToRoute': null
        };

        if (newConn.startType == 'out') {
            connReq.FromId = newConn.start.Id;
            connReq.ToId = block.Id;
            connReq.ToRoute = route;
        } else {
            connReq.FromId = block.Id;
            connReq.ToId = newConn.start.Id;
            connReq.ToRoute = newConn.startRoute;
        }

        $.ajax({
            url: '/connections',
            type: 'POST',
            data: JSON.stringify(connReq),
            success: function(result) {}
        });

        terminateConnection();
    }

    function updateNewConnection() {
        newConnection.attr('d', function() {
            return lineStyle(newConn.startType == 'out' ?
                [{
                    x: newConn.start.Position.X + HALF_ROUTE,
                    y: (newConn.start.Position.Y + newConn.start.height * 2) - HALF_ROUTE
                }, {
                    x: newConn.start.Position.X + HALF_ROUTE,
                    y: (newConn.start.Position.Y + newConn.start.height * 2) + ROUTE_SPACE
                }, {
                    x: mouse.x,
                    y: mouse.y - ROUTE_SPACE
                }, {
                    x: mouse.x,
                    y: mouse.y
                }] :
                [{
                    x: newConn.start.Position.X + (newConn.start.TypeInfo.InRoutes.indexOf(newConn.startRoute) * ROUTE_SPACE) + HALF_ROUTE,
                    y: newConn.start.Position.Y + HALF_ROUTE
                }, {
                    x: newConn.start.Position.X + (newConn.start.TypeInfo.InRoutes.indexOf(newConn.startRoute) * ROUTE_SPACE) + HALF_ROUTE,
                    y: newConn.start.Position.Y - ROUTE_SPACE
                }, {
                    x: mouse.x,
                    y: mouse.y + ROUTE_SPACE
                }, {
                    x: mouse.x,
                    y: mouse.y
                }]);
        })
    }

    function terminateConnection() {
        newConnection.style('visibility', 'hidden');
        isConnecting = false;
        newConn = {};
    }
});
